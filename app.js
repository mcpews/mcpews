const EventEmitter = require("events");
const WSServer = require("./server");

class AppSession {
    constructor(session) {
        this.session = session;
    }

    enableEncryption() {
        return new Promise((resolve) => this.session.enableEncryption(resolve));
    }

    isEncrypted() {
        return this.session.isEncrypted();
    }

    on(event, listener) {
        this.session.subscribe(event, listener);
        return this;
    }

    once(event, listener) {
        const holderListener = () => void 0; // used to delay the unsubscribe request
        const wrappedListener = function (...args) {
            this.session.unsubscribe(event, wrappedListener);
            listener.apply(this, args);
            this.session.unsubscribe(event, holderListener);
        };
        this.session.subscribe(event, wrappedListener);
        this.session.subscribe(event, holderListener);
        return this;
    }

    off(event, listener) {
        this.session.unsubscribe(event, listener);
        return this;
    }

    addListener(event, listener) {
        return this.on(event, listener);
    }

    removeListener(event, listener) {
        return this.off(event, listener);
    }

    waitForEvent(event, timeout) {
        return waitForEvent(this, event, timeout);
    }

    command(command) {
        return new Promise((resolve, reject) => {
            this.session.once("mcError", reject);
            this.session.sendCommand(command, (body) => {
                resolve(body);
                this.session.off("mcError", reject);
            });
        });
    }

    commandLegacy(commandName, overload, input) {
        return new Promise((resolve, reject) => {
            this.session.once("mcError", reject);
            this.session.sendCommandLegacy(commandName, overload, input, (body) => {
                resolve(body);
                this.session.off("mcError", reject);
            });
        });
    }

    disconnect(timeout) {
        this.session.disconnect();
        return waitForEvent(this.session, "disconnect", timeout);
    }
}

class WSApp extends EventEmitter {
    constructor(port) {
        super();
        this.server = new WSServer(port, onSession.bind(this));
    }

    waitForSession(timeout) {
        return waitForEvent(this, "session", timeout);
    }
}

module.exports = WSApp;

function onSession(session) {
    const appSession = new AppSession(session);
    appSession.on("error", (err) => this.emit("error", err));
    this.emit("session", appSession);
}

function waitForEvent(emitter, eventName, timeout) {
    return new Promise((resolve, reject) => {
        const listener = (data) => {
            resolve(data);
            emitter.removeListener(eventName, listener);
        };
        emitter.addListener(eventName, listener);
        if (timeout) {
            setTimeout(() => {
                emitter.removeListener(eventName, listener);
                reject(new Error(`${eventName}: Timeout ${timeout} exceed.`));
            }, timeout);
        }
    });
}
