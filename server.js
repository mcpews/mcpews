const EventEmitter = require("events");
const WebSocket = require("ws");
const randomUUID = require("uuid").v4;
const { implementName, ServerEncryption } = require("./encrypt");

const kSecWebsocketKey = Symbol("sec-websocket-key");

class WSServer extends WebSocket.Server {
    constructor(port, handleClient) {
        super({
            port: port,
            handleProtocols: (protocols) => {
                return protocols.find((protocol) => protocol == implementName);
            }
        });
        this.sessions = new Set();
        this.on("connection", onConnection);
        if (handleClient) {
            this.on("client", handleClient);
        }
    }

    // overwrite handleUpgrade to skip sec-websocket-key format test
    handleUpgrade(req, socket, head, cb) {
        const key = req.headers["sec-websocket-key"];
        if (key && /^[+/0-9A-Za-z]{11}=$/.test(key)) {
            req.headers["sec-websocket-key"] = "skipkeytest" + key + "=";
            req[kSecWebsocketKey] = key;
        }
        super.handleUpgrade(req, socket, head, cb);
    }

    // same reason as above
    completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (req[kSecWebsocketKey]) {
            key = req[kSecWebsocketKey];
        }
        super.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
    }

    broadcastCommand(command, callback) {
        this.sessions.forEach((e) => {
            e.sendCommand(command, callback);
        });
    }

    broadcastSubscribe(event, callback) {
        this.sessions.forEach((e) => {
            e.subscribe(event, callback);
        });
    }

    broadcastUnsubscribe(event, callback) {
        this.sessions.forEach((e) => {
            e.unsubscribe(event, callback);
        });
    }

    disconnectAll(force) {
        this.sessions.forEach((e) => {
            e.disconnect(force);
        });
    }
}

class Session extends EventEmitter {
    constructor(server, socket) {
        super();
        this.server = server;
        this.socket = socket;
        this.eventListeners = new Map();
        this.responsors = new Map();
        socket.on("message", onMessage.bind(this)).on("close", onClose.bind(this));
    }

    enableEncryption(callback) {
        if (this.exchangingKey || this.encryption) {
            return false;
        } else {
            let encryption = new ServerEncryption();
            let keyExchangeParams = encryption.beginKeyExchange();
            this.exchangingKey = true;
            this.sendCommand(
                [
                    "enableencryption",
                    JSON.stringify(keyExchangeParams.publicKey),
                    JSON.stringify(keyExchangeParams.salt)
                ],
                (res) => {
                    this.exchangingKey = false;
                    encryption.completeKeyExchange(res.publicKey);
                    this.encryption = encryption;
                    if (callback) callback.call(this, this);
                    this.emit("encryptionEnabled", this);
                }
            );
            return true;
        }
    }

    isEncrypted() {
        return this.encryption != null;
    }

    sendMessage(message) {
        let messageData = JSON.stringify(message);
        if (this.encryption) {
            messageData = this.encryption.encrypt(messageData);
        }
        this.socket.send(messageData);
    }

    sendFrame(messagePurpose, body, uuid) {
        this.sendMessage({
            header: buildHeader(messagePurpose, uuid),
            body: body
        });
    }

    subscribeRaw(event) {
        this.sendFrame("subscribe", {
            eventName: event
        });
    }

    subscribe(event, callback) {
        let listeners = this.eventListeners.get(event);
        if (listeners == undefined) {
            listeners = new Set();
            this.eventListeners.set(event, listeners);
            this.subscribeRaw(event);
        }
        listeners.add(callback);
    }

    unsubscribeRaw(event) {
        this.sendFrame("unsubscribe", {
            eventName: event
        });
    }

    unsubscribe(event, callback) {
        let listeners = this.eventListeners.get(event);
        if (listeners == undefined) {
            return;
        }
        listeners.delete(callback);
        if (listeners.size == 0) {
            this.eventListeners.delete(event);
            this.unsubscribeRaw(event);
        }
    }

    publishEvent(event, body, message) {
        let listeners = this.eventListeners.get(event);
        if (listeners) {
            const listenersCopy = new Set(listeners);
            listenersCopy.forEach((e) => {
                try {
                    e.call(this, body, message, this);
                } catch (err) {
                    this.emit("error", err);
                }
            });
        } else {
            this.emit("event", event, body, message, this);
        }
    }

    sendCommandRaw(requestId, command) {
        this.sendFrame(
            "commandRequest",
            {
                version: 1,
                commandLine: command,
                origin: {
                    type: "player"
                }
            },
            requestId
        );
    }

    sendCommand(command, callback) {
        let requestId = randomUUID();
        this.responsors.set(requestId, callback);
        this.sendCommandRaw(requestId, Array.isArray(command) ? command.join(" ") : command);
        return requestId;
    }

    sendCommandLegacyRaw(requestId, commandName, overload, input) {
        this.sendFrame(
            "commandRequest",
            {
                version: 1,
                name: commandName,
                overload: overload,
                input: input,
                origin: { type: "player" }
            },
            requestId
        );
    }

    sendCommandLegacy(commandName, overload, input, callback) {
        let requestId = randomUUID();
        this.responsors.set(requestId, callback);
        this.sendCommandLegacyRaw(requestId, commandName, overload, input);
        return requestId;
    }

    respondCommand(requestId, body, message) {
        let callback = this.responsors.get(requestId);
        this.responsors.delete(requestId);
        if (callback) {
            try {
                callback.call(this, body, message, this);
            } catch (err) {
                this.emit("error", err);
            }
        } else {
            this.emit("commandResponse", requestId, body, message, this);
        }
    }

    disconnect(force) {
        if (force) {
            this.socket.close();
        } else {
            this.sendCommand("closewebsocket", null);
        }
    }
}

module.exports = WSServer;

function onConnection(socket, req) {
    let session = new Session(this, socket);
    this.sessions.add(session);
    this.emit("client", session, req);
}

function onMessage(messageData) {
    if (this.encryption) messageData = this.encryption.decrypt(messageData);
    let message = JSON.parse(messageData);
    let { header, body } = message;
    switch (header.messagePurpose) {
        case "event":
            this.publishEvent(body.eventName, body, message);
            break;
        case "commandResponse":
            this.respondCommand(header.requestId, body, message);
            break;
        case "error":
            this.emit("mcError", body.statusCode, body.statusMessage, body, message, this);
            break;
        default:
            this.emit("customFrame", header.messagePurpose, body, header, message, this);
    }
    this.emit("message", message, this);
}

function onClose() {
    this.server.sessions.delete(this);
    this.emit("disconnect", this);
}

function buildHeader(purpose, uuid) {
    return {
        version: 1,
        requestId: uuid || "00000000-0000-0000-0000-000000000000",
        messagePurpose: purpose,
        messageType: "commandRequest"
    };
}
