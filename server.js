const EventEmitter = require("events");
const WebSocket = require("ws");
const randomUUID = require("uuid").v4;
const { ServerEncryption } = require("./encrypt");

class WSServer extends WebSocket.Server {
    constructor (port, processor) {
        super({ port: port });
        this.sessions = new Set();
        this.on("connection", onConn);
        if (processor) this.on("client", processor);
    }

    broadcastCommand (command, callback) {
        this.sessions.forEach(e => {
            e.sendCommand(command, callback);
        });
    }

    broadcastSubscribe (event, callback) {
        this.sessions.forEach(e => {
            e.subscribe(event, callback);
        });
    }

    broadcastUnsubscribe (event, callback) {
        this.sessions.forEach(e => {
            e.unsubscribe(event, callback);
        });
    }

    disconnectAll (forced) {
        this.sessions.forEach(e => {
            e.disconnect(forced);
        });
    }
}

class Session extends EventEmitter {
    constructor (server, socket) {
        super();
        this.server = server;
        this.socket = socket;
        this.eventListeners = new Map();
        this.responsors = new Map();
        socket.on("message", onMessage.bind(this))
            .on("close", onClose.bind(this));
    }

    enableEncryption (callback) {
        let encryption = new ServerEncryption();
        let keyExchangeParams = encryption.beginKeyExchange();
        this.sendCommand([
            "enableencryption",
            JSON.stringify(keyExchangeParams.publicKey),
            JSON.stringify(keyExchangeParams.salt)
        ], res => {
            encryption.completeKeyExchange(res.publicKey);
            this.encryption = encryption;
            if (callback) callback.call(this, this);
            this.emit("encryptionEnabled", this);
        });
    }

    isEncrypted () {
        return this.encryption != null;
    }

    sendJSON (json) {
        if (this.encryption) {
            this.socket.send(this.encryption.encrypt(JSON.stringify(json)));
        } else {
            this.socket.send(JSON.stringify(json));
        }
    }

    sendFrame (messagePurpose, body, uuid) {
        this.sendJSON({
            header: buildHeader(messagePurpose, uuid),
            body: body
        });
    }

    subscribeRaw (event) {
        this.sendFrame("subscribe", {
            eventName: event
        });
    }

    subscribe (event, callback) {
        let listeners = this.eventListeners.get(event);
        if (listeners == undefined) {
            listeners = new Set();
            this.eventListeners.set(event, listeners);
            this.subscribeRaw(event);
        }
        listeners.add(callback);
    }

    unsubscribeRaw (event) {
        this.sendFrame("unsubscribe", {
            eventName: event
        });
    }

    unsubscribe (event, callback) {
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

    sendCommandRaw (requestId, command) {
        this.sendFrame("commandRequest", {
            version: 1,
            commandLine: command,
            origin: {
                type: "player"
            }
        }, requestId);
    }

    sendCommand (command, callback) {
        let requestId = randomUUID();
        this.responsors.set(requestId, callback);
        this.sendCommandRaw(requestId, Array.isArray(command) ? command.join(" ") : command);
        return requestId;
    }

    sendCommandLegacyRaw (requestId, commandName, overload, input) {
        this.sendFrame("commandRequest", {
            version: 1,
            name: commandName,
            overload: overload,
            input: input,
            origin: { type: "player" }
        }, requestId);
    }

    sendCommandLegacy (commandName, overload, input, callback) {
        let requestId = randomUUID();
        this.responsors.set(requestId, callback);
        this.sendCommandLegacyRaw(requestId, commandName, overload, input);
        return requestId;
    }

    disconnect (forced) {
        if (forced) {
            this.socket.close();
        } else {
            this.sendCommand("closewebsocket", null);
        }
    }
}

module.exports = WSServer;

function onConn(socket, req) {
    let session = new Session(this, socket);
    this.sessions.add(session);
    this.emit("client", session, req);
}

function onMessage(message) {
    if (this.encryption) message = this.encryption.decrypt(message);
    let json = JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : message);
    let header = json.header, body = json.body;
    switch (header.messagePurpose) {
        case "event":
            let listeners = this.eventListeners.get(body.eventName);
            if (listeners) {
                listeners.forEach(e => {
                    try {
                        e.call(this, body, json, this);
                    } catch(err) {
                        this.emit("error", err);
                    }
                });
            } else {
                this.emit("event", body.eventName, body, json, this);
            }
            break;
        case "commandResponse":
            let callback = this.responsors.get(header.requestId);
            this.responsors.delete(header.requestId);
            if (callback) {
                try {
                    callback.call(this, body, json, this);
                } catch(err) {
                    this.emit("error", err);
                }
            } else {
                this.emit("commandResponse", header.requestId, body, json, this);
            }
            break;
        case "error":
            this.emit("mcError", body.statusCode, body.statusMessage, body.statusCode, json, this);
            break;
        default:
            this.emit("customFrame", header.messagePurpose, body, header, json, this);
    }
    this.emit("message", json, this);
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