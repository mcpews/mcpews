#!/usr/bin/env node

const EventEmitter = require("events");
const os = require("os");
const readline = require("readline");
const repl = require("repl");
const vm = require("vm");
const util = require("util");
const WSServer = require("./server");

class SingleSessionServer extends EventEmitter {
    constructor (port) {
        super();
        this.port = port;
        this.wsServer = new WSServer(port);
        this.eventListeners = new Map();
        this.session = null;
        this.wsServer.on("client", (newSession, request) => {
            if (this.session) {
                newSession.disconnect();
                return;
            }
            let address = request.client.remoteAddress + ":" + request.client.remotePort;
            newSession.on("disconnect", () => {
                this.session = null;
                this.emit("offline", address);
            });
            this.session = newSession;
            this.emit("online", address);
        });
    }

    isOnline () {
        return this.session != null;
    }

    getSession () {
        if (!this.session) throw new Error("Connection is not established.");
        return this.session;
    }

    encrypt () {
        return new Promise((resolve, reject) => {
            let sess = this.getSession();
            sess.on("mcError", reject);
            if (!sess.enableEncryption(() => {
                resolve(true);
                sess.removeListener("mcError", reject);
            })) {
                resolve(false);
            };
        });
    }

    disconnect (force) {
        this.getSession().disconnect(force);
    }

    disconnectAll () {
        this.wsServer.disconnectAll();
    }

    _eventListener (eventName, body) {
        this.emit("event", eventName, body);
    }

    subscribe (eventName) {
        let sess = this.getSession();
        let listener = this.eventListeners.get(eventName);
        if (!listener) {
            listener = this._eventListener.bind(this, eventName);
            sess.subscribe(eventName, listener);
            this.eventListeners.set(eventName, listener);
            return true;
        }
        return false;
    }

    unsubscribe (eventName) {
        let sess = this.getSession();
        let listener = this.eventListeners.get(eventName);
        if (listener) {
            sess.unsubscribe(eventName, listener);
            this.eventListeners.delete(eventName);
            return true;
        }
        return false;
    }

    sendCommand (cmd) {
        return new Promise((resolve, reject) => {
            let sess = this.getSession();
            sess.on("mcError", reject);
            sess.sendCommand(cmd, res => {
                resolve(res);
                sess.removeListener("mcError", reject);
            });
        });
    }

    sendCommandLegacy (commandName, overload, input) {
        return new Promise((resolve, reject) => {
            let sess = this.getSession();
            sess.on("mcError", reject);
            sess.sendCommandLegacy(commandName, overload, input, res => {
                resolve(res);
                sess.removeListener("mcError", reject);
            });
        });
    }

    allConnectCommands (externalOnly) {
        let interfaces = os.networkInterfaces();
        let ips = [];
        let devName, infoList;
        for (devName in interfaces) {
            infoList = interfaces[devName].filter(niInfo => niInfo.family == "IPv4");
            if (externalOnly) {
                infoList = infoList.filter(niInfo => !niInfo.internal && niInfo.address != "127.0.0.1");
            }
            ips.push(...infoList.map(niInfo => niInfo.address));
        }
        if (ips.length == 0) ips.push("0.0.0.0");
        return ips.map(ip => `/connect ${ip}:${this.port}`);
    }

    connectCommand () {
        return this.allConnectCommands(true)[0];
    }
}

const OFFLINE_PROMPT = "[Offline] > ";
const ONLINE_PROMPT = "> "
class CommandReplServer extends repl.REPLServer {
    constructor (port) {
        super({
            prompt: OFFLINE_PROMPT,
            eval: (cmd, context, file, callback) => {
                this._eval(cmd, context, file, callback);
            }
        });
        this.server = new SingleSessionServer(port);
        this._defineDefaultCommands();
        this.on("reset", context => this._resetContext(context))
            .on("exit", () => this.server.disconnectAll());
        this._resetContext(this.context);
        this.server
            .on("online", address => {
                this._printLine(`${OFFLINE_PROMPT}\nConnection established: ${address}.\nType ".help" for more information.`, true);
                this.setPrompt(ONLINE_PROMPT);
                this.displayPrompt(true);
            })
            .on("offline", address => {
                this._printLine(`Connection disconnected: ${address}.`, true);
                this._showOfflinePrompt(true);
                this.setPrompt(OFFLINE_PROMPT);
                this.displayPrompt(true);
            })
            .on("event", (eventName, body) => {
                if (this.editorMode) return;
                this._printLine(util.format("[%s] %o", eventName, body), true);
            });
        this._showOfflinePrompt(true);
    }

    _printLine (str, rewriteLine) {
        if (rewriteLine) {
            readline.cursorTo(this.output, 0);
            readline.clearLine(this.output, 0);
        }
        this.output.write(str + "\n");
        this.displayPrompt(true);
    }

    _showOfflinePrompt (singleLine) {
        if (singleLine) {
            this._printLine(`Type "${this.server.connectCommand()}" in the game console to connect.`, true);
        } else {
            this._printLine(`Type one of following commands in the game console to connect:\n${this.server.allConnectCommands().join("\n")}`, true);
        }
    }

    _resetContext (context) {
        Object.defineProperties(context, {
            wss: {
                configurable: true,
                writable: false,
                value: this.server.wsServer
            },
            session: {
                configurable: true,
                get: () => this.server.getSession()
            },
            encrypt: {
                configurable: true,
                value: () => this.server.encrypt()
            },
            disconnect: {
                configurable: true,
                value: () => this.server.disconnect()
            },
            subscribe: {
                configurable: true,
                value: eventName => this.server.subscribe(eventName)
            },
            unsubscribe: {
                configurable: true,
                value: eventName => this.server.unsubscribe(eventName)
            },
            command: {
                configurable: true,
                value: commandLine => this.server.sendCommand(commandLine)
            },
            commandLegacy: {
                configurable: true,
                value: (commandName, overload, input) => this.server.sendCommandLegacy(commandName, overload, input)
            }
        });
    }

    _defineDefaultCommands () {
        this.defineCommand("subscribe", {
            help: "Subscribe a event",
            action: eventName => {
                if (this.server.isOnline()) {
                    if (this.server.subscribe(eventName)) {
                        this._printLine(`Subscribed ${eventName}.`);
                    } else {
                        this._printLine(`Event ${eventName} is already subscribed.`);
                    }
                } else {
                    this._printLine("Connection is not established.");
                }
            }
        });
        this.defineCommand("unsubscribe", {
            help: "Unsubscribe a event",
            action: eventName => {
                if (this.server.isOnline()) {
                    if (this.server.unsubscribe(eventName)) {
                        this._printLine(`Unsubscribed ${eventName}.`);
                    } else {
                        this._printLine(`Event ${eventName} is not subscribed.`);
                    }
                } else {
                    this._printLine("Connection is not established.");
                }
            }
        });
        this.defineCommand("disconnect", {
            help: "Disconnect from all the clients",
            action: arg => {
                if (this.server.isOnline()) {
                    if (arg == "force") {
                        this.server.disconnect(true);
                    } else {
                        let disconnected = false;
                        let timeout = setTimeout(() => {
                            if (disconnected) return;
                            this._printLine("Connection close request timeout.");
                            this.server.disconnect(true);
                        }, 10000);
                        this.server.once("offline", () => {
                            disconnected = true;
                            clearTimeout(timeout);
                        });
                        this.server.disconnect(false);
                    }
                } else {
                    this._printLine("Connection is not established.");
                }
            }
        });
        this.defineCommand("encrypt", {
            help: "Encrypt the connection",
            action: () => {
                if (this.server.isOnline()) {
                    this.server.encrypt().then(() => {
                        this._printLine("Connection is encrypted.", true);
                    });
                } else {
                    this._printLine("Connection is not established.");
                }
            }
        });
    }

    _eval (cmd, context, file, callback) {
        let result;
        try {
            let trimmedCmd = cmd.trim();
            if (trimmedCmd.startsWith("/") && !trimmedCmd.includes("\n")) {
                if (!this.server.isOnline() && trimmedCmd.startsWith("/connect")) {
                    this._showOfflinePrompt();
                    return callback(null);
                }
                result = this.server.sendCommand(trimmedCmd.slice(1));
            } else if (trimmedCmd.length > 0) {
                result = vm.runInContext(cmd, context, {
                    filename: file
                });
            } else {
                return callback(null);
            }
            if (result && result.then) {
                result.then(res => callback(null, res), err => callback(err));
            } else {
                callback(null, result);
            }
        } catch(err) {
            callback(err);
        }
    }
}

function mainRepl(port) {
    let replServer = new CommandReplServer(port);
    replServer.on("exit", () => {
        process.exit(0);
    });
}

mainRepl(Number(process.argv[2]) || 19134);