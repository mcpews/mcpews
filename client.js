const EventEmitter = require("events");
const WebSocket = require('ws');
const { ClientEncryption } = require("./encrypt");

class WSClient extends EventEmitter {
    constructor (address) {
        super();
        this.socket = new WebSocket(address);
        this.eventListenMap = new Map();
        this.socket.on("message", onMessage.bind(this))
            .on("close", onClose.bind(this));
    }

    handleEncryptionHandshake (requestId, commandLine) {
        if (commandLine.startsWith("enableencryption ")) {
            let encryption = new ClientEncryption();
            let keyExchangeParams = encryption.beginKeyExchange();
            let args = commandLine.split(" ");
            encryption.completeKeyExchange(JSON.parse(args[1]), JSON.parse(args[2]));
            this.respondCommand(requestId, {
                publicKey: keyExchangeParams.publicKey,
                statusCode: 0
            });
            this.encryption = encryption;
            this.emit("encryptionEnabled", this);
            return true;
        }
        return false;
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

    sendError (statusCode, statusMessage) {
        this.sendFrame("error", {
            statusCode,
            statusMessage
        });
    }

    sendEvent (eventName, body) {
        this.sendFrame("event", {
            ...body,
            eventName
        });
    }

    emitEvent (eventName, body) {
        let isEventListening = this.eventListenMap.get(eventName);
        if (isEventListening) {
            this.sendEvent(eventName, body);
        }
    }

    respondCommand (requestId, body) {
        this.sendFrame("commandResponse", body, requestId);
    }

    disconnect () {
        this.socket.close();
    }
}

module.exports = WSClient;

function onMessage(message) {
    if (this.encryption) message = this.encryption.decrypt(message);
    let json = JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : message);
    let header = json.header, body = json.body;
    switch (header.messagePurpose) {
        case "subscribe":
        case "unsubscribe":
            let isEventListening = this.eventListenMap.get(body.eventName);
            if (header.messagePurpose == "subscribe" && !isEventListening) {
                this.emit("subscribe", body.eventName, body, json, this);
                this.eventListenMap.set(body.eventName, true);
            } else if (header.messagePurpose == "unsubscribe" && isEventListening) {
                this.emit("unsubscribe", body.eventName, body, json, this);
                this.eventListenMap.set(body.eventName, false);
            }
            break;
        case "commandRequest":
            if (body.commandLine) {
                this.emit("command", header.requestId, body.commandLine, body, json, this);
            } else {
                this.emit("commandLegacy", header.requestId, body.name, body.overload, body.input, body, json, this);
            }
            break;
        default:
            this.emit("customFrame", header.messagePurpose, body, header.requestId, json, this);
    }
    this.emit("message", json, this);
}

function onClose() {
    this.emit("disconnect", this);
}

function buildHeader(purpose, uuid) {
    return {
        version: 1,
        requestId: uuid || "00000000-0000-0000-0000-000000000000",
        messagePurpose: purpose
    };
}