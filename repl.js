#!/usr/bin/env node

const repl = require("repl");
const vm = require("vm");
const util = require("util");
const WSServer = require("./server");

function mainRepl(port) {
    let wss = new WSServer(port);
    let session = null;
    let sessionGetter = () => {
        if (!session) throw new Error("Connection is not established.");
        return session;
    };
    let replWrite = (str) => {
        process.stdout.write(str + "\n");
        replServer.prompt(true);
    };
    let eventListener = (eventName, body) => {
        replWrite(util.format("\n[%s] %o", eventName, body));
    };
    let eventListeners = new Map();
    let context = vm.createContext({
        get session() {
            return sessionGetter();
        },
        wss,
        encrypt() {
            return new Promise((resolve, reject) => {
                let sess = sessionGetter();
                sess.on("mcError", reject);
                sess.enableEncryption(() => {
                    resolve(true);
                    sess.removeListener("mcError", reject);
                });
            });
        },
        disconnect() {
            sessionGetter().disconnect();
        },
        subscribe(eventName) {
            let sess = sessionGetter();
            let listener = eventListeners.get(eventName);
            if (!listener) {
                listener = eventListener.bind(null, eventName);
                sess.subscribe(eventName, listener);
                eventListeners.set(eventName, listener);
                return eventName;
            }
            return null;
        },
        unsubscribe(eventName) {
            let sess = sessionGetter();
            let listener = eventListeners.get(eventName);
            if (listener) {
                sess.unsubscribe(eventName, listener);
                eventListeners.delete(eventName);
                return eventName;
            }
            return null;
        },
        command(cmd) {
            return new Promise((resolve, reject) => {
                let sess = sessionGetter();
                sess.on("mcError", reject);
                sess.sendCommand(cmd, res => {
                    resolve(res);
                    sess.removeListener("mcError", reject);
                });
            });
        },
        commandLegacy(commandName, overload, input) {
            return new Promise((resolve, reject) => {
                let sess = sessionGetter();
                sess.on("mcError", reject);
                sess.sendCommandLegacy(commandName, overload, input, res => {
                    resolve(res);
                    sess.removeListener("mcError", reject);
                });
            });
        }
    });
    process.stdout.write(`Enter '/connect <ip address>:${port}' to establish a connection.\n`);
    let replServer = repl.start({
        prompt: "[Offline] > ",
        eval: function(cmd, _, file, callback) {
            let result;
            try {
                if (cmd.startsWith("/")) {
                    result = context.command(cmd.slice(1).replace(/\n$/, ""));
                } else {
                    result = vm.runInContext(cmd, context, {
                        filename: file
                    });
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
    });
    wss.on("client", newSession => {
        if (session) {
            newSession.disconnect();
            return;
        }
        session = newSession;
        replServer.setPrompt("> ");
        replServer.prompt(true);
        session.on("disconnect", () => {
            session = null;
            replServer.setPrompt("[Offline] > ");
            replServer.prompt(true);
        });
    });
    replServer.defineCommand("subscribe", {
        help: "Subscribe a event",
        action(eventName) {
            if (session) {
                if (context.subscribe(eventName)) {
                    replWrite(`Subscribed ${eventName}.`);
                } else {
                    replWrite(`Event ${eventName} is already subscribed.`);
                }
            } else {
                replWrite("Connection is not established.");
            }
        }
    });
    replServer.defineCommand("unsubscribe", {
        help: "Unsubscribe a event",
        action(eventName) {
            if (session) {
                if (context.unsubscribe(eventName)) {
                    replWrite(`Unsubscribed ${eventName}.`);
                } else {
                    replWrite(`Event ${eventName} is not subscribed.`);
                }
            } else {
                replWrite("Connection is not established.");
            }
        }
    });
    replServer.defineCommand("disconnect", {
        help: "Disconnect from all the clients",
        action() {
            if (session) {
                session.disconnect();
                replWrite("Connection disconnected.");
            } else {
                replWrite("Connection is not established.");
            }
        }
    });
    replServer.on("exit", () => {
        wss.disconnectAll();
        process.exit(0);
    });
}

mainRepl(Number(process.argv[2]) || 19134);