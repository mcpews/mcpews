const EventEmitter = require("events");
const WebSocket = require("ws");
const { ClientEncryption } = require("./encrypt");

class WSClient extends EventEmitter {
    constructor(address) {
        super();
        this.socket = new WebSocket(address);
        this.eventListenMap = new Map();
        this.socket.on("message", onMessage.bind(this))
        this.socket.on("close", onClose.bind(this));
    }

    handleEncryptionHandshake(requestId, commandLine) {
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

    sendError(statusCode, statusMessage) {
        this.sendFrame("error", {
            statusCode,
            statusMessage
        });
    }

    sendEvent(eventName, body) {
        this.sendFrame("event", {
            ...body,
            eventName
        });
    }

    publishEvent(eventName, body) {
        let isEventListening = this.eventListenMap.get(eventName);
        if (isEventListening) {
            this.sendEvent(eventName, body);
        }
    }

    respondCommand(requestId, body) {
        this.sendFrame("commandResponse", body, requestId);
    }

    disconnect() {
        this.socket.close();
    }
}

module.exports = WSClient;

function onMessage(messageData) {
    if (this.encryption) messageData = this.encryption.decrypt(messageData);
    let message = JSON.parse(messageData);
    let { header, body } = message;
    switch (header.messagePurpose) {
        case "subscribe":
        case "unsubscribe":
            let isEventListening = this.eventListenMap.get(body.eventName);
            if (header.messagePurpose == "subscribe" && !isEventListening) {
                this.emit("subscribe", body.eventName, body, message, this);
                this.eventListenMap.set(body.eventName, true);
            } else if (header.messagePurpose == "unsubscribe" && isEventListening) {
                this.emit("unsubscribe", body.eventName, body, message, this);
                this.eventListenMap.set(body.eventName, false);
            }
            break;
        case "commandRequest":
            if (body.commandLine) {
                this.emit("command", header.requestId, body.commandLine, body, message, this);
            } else {
                this.emit("commandLegacy", header.requestId, body.name, body.overload, body.input, body, message, this);
            }
            break;
        default:
            this.emit("customFrame", header.messagePurpose, body, header.requestId, message, this);
    }
    this.emit("message", message, this);
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
