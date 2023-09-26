#!/usr/bin/env node

import EventEmitter from 'events';
import os from 'os';
import readline from 'readline';
import { REPLServer, start as startREPL } from 'repl';
import vm, { Context } from 'vm';
import util from 'util';
import { AppSession, EventFrame, WSApp } from './index.js';

function sessionEventListener(this: SingleSessionServer, eventName: string, { body }: EventFrame) {
    this.emit('event', eventName, body);
}

type SessionEventHandler = (event: EventFrame) => void;

class SingleSessionServer extends EventEmitter {
    port: number;
    app: WSApp;
    session: AppSession | null;
    eventListeners: Map<string, SessionEventHandler>;
    timeout: number;

    constructor(port: number) {
        super();
        this.port = port;
        this.app = new WSApp(port);
        this.session = null;
        this.eventListeners = new Map();
        this.timeout = 3000;
        this.app.on('session', ({ session: newSession, request }) => {
            if (this.session) {
                void newSession.disconnect(true);
                return;
            }
            const address = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
            newSession.on('Disconnect', () => {
                this.session = null;
                this.emit('offline', address);
            });
            this.session = newSession;
            this.emit('online', address);
        });
    }

    isOnline() {
        return this.session != null;
    }

    getSession() {
        if (!this.session) throw new Error('Connection is not established.');
        return this.session;
    }

    encrypt() {
        return this.getSession().enableEncryption();
    }

    async disconnect(force?: boolean) {
        await this.session?.disconnect(force, this.timeout);
        this.app.close();
    }

    subscribe(eventName: string) {
        const session = this.getSession();
        let listener = this.eventListeners.get(eventName);
        if (!listener) {
            listener = sessionEventListener.bind(this, eventName);
            session.on(eventName, listener);
            this.eventListeners.set(eventName, listener);
            return true;
        }
        return false;
    }

    unsubscribe(eventName: string) {
        const session = this.getSession();
        const listener = this.eventListeners.get(eventName);
        if (listener) {
            session.off(eventName, listener);
            this.eventListeners.delete(eventName);
            return true;
        }
        return false;
    }

    async sendCommand(commandLine: string | string[]) {
        const session = this.getSession();
        const { body } = await session.command(commandLine, this.timeout);
        return body;
    }

    async sendCommandLegacy(commandName: string, overload: string, input: Record<string, unknown>) {
        const session = this.getSession();
        const { body } = await session.commandLegacy(commandName, overload, input, this.timeout);
        return body;
    }

    allConnectCommands(externalOnly?: boolean) {
        const interfaces = os.networkInterfaces();
        const ips = [];
        Object.values(interfaces).forEach((devInfos) => {
            if (!devInfos) return;
            let infoList = devInfos.filter((niInfo) => niInfo.family === 'IPv4');
            if (externalOnly) {
                infoList = infoList.filter((niInfo) => !niInfo.internal && niInfo.address !== '127.0.0.1');
            }
            ips.push(...infoList.map((niInfo) => niInfo.address));
        });
        if (ips.length === 0) ips.push('0.0.0.0');
        return ips.map((ip) => `/connect ${ip}:${this.port}`);
    }

    connectCommand() {
        return this.allConnectCommands(true)[0];
    }
}

const OFFLINE_PROMPT = '[Offline] > ';
const ONLINE_PROMPT = '> ';
class CommandReplServer {
    repl: REPLServer;
    server: SingleSessionServer;
    acceptUserInput: boolean;
    exitOnClose: boolean;

    constructor(port: number) {
        this.repl = startREPL({
            prompt: OFFLINE_PROMPT,
            eval: (cmd, context, file, callback) => {
                this.doEval(cmd, context, file, callback);
            }
        });
        this.server = new SingleSessionServer(port);
        this.acceptUserInput = true;
        this.exitOnClose = true;
        this.defineDefaultCommands();
        this.repl
            .on('reset', (context) => {
                this.resetContextScope(context);
            })
            .on('exit', () => {
                if (this.exitOnClose) {
                    process.exit();
                } else {
                    void this.server.disconnect();
                }
            });
        this.resetContextScope(this.repl.context);
        this.server
            .on('online', (address) => {
                this.printLine(
                    `${OFFLINE_PROMPT}\nConnection established: ${address}.\nType ".help" for more information.`,
                    true
                );
                this.repl.setPrompt(ONLINE_PROMPT);
                if (this.acceptUserInput) {
                    this.repl.displayPrompt(true);
                }
            })
            .on('offline', (address) => {
                this.printLine(`Connection disconnected: ${address}.`, true);
                this.showOfflinePrompt(true);
                this.repl.setPrompt(OFFLINE_PROMPT);
                if (this.acceptUserInput) {
                    this.repl.displayPrompt(true);
                }
            })
            .on('event', (eventName, body) => {
                if (this.repl.editorMode) return;
                this.printLine(util.format('[%s] %o', eventName, body), true);
            });
        this.showOfflinePrompt(true);
    }

    printLine(str: string, rewriteLine?: boolean) {
        if (rewriteLine) {
            readline.cursorTo(this.repl.output, 0);
            readline.clearLine(this.repl.output, 0);
        }
        this.repl.output.write(`${str}\n`);
        if (this.acceptUserInput) {
            this.repl.displayPrompt(true);
        }
    }

    showOfflinePrompt(singleLine?: boolean) {
        if (singleLine) {
            this.printLine(`Type "${this.server.connectCommand()}" in the game console to connect.`, true);
        } else {
            const allConnectCommands = this.server.allConnectCommands().join('\n');
            this.printLine(
                `Type one of following commands in the game console to connect:\n${allConnectCommands}`,
                true
            );
        }
    }

    resetContextScope(context: Context) {
        Object.defineProperties(context, {
            app: {
                configurable: true,
                writable: false,
                value: this.server.app
            },
            wss: {
                configurable: true,
                writable: false,
                value: this.server.app.server
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
                value: (eventName: string) => this.server.subscribe(eventName)
            },
            unsubscribe: {
                configurable: true,
                value: (eventName: string) => this.server.unsubscribe(eventName)
            },
            command: {
                configurable: true,
                value: (commandLine: string) => this.server.sendCommand(commandLine)
            },
            commandLegacy: {
                configurable: true,
                value: (commandName: string, overload: string, input: Record<string, unknown>) => {
                    return this.server.sendCommandLegacy(commandName, overload, input);
                }
            }
        });
    }

    defineDefaultCommands() {
        this.repl.defineCommand('subscribe', {
            help: 'Subscribe a event',
            action: (eventName) => {
                if (this.server.isOnline()) {
                    if (this.server.subscribe(eventName)) {
                        this.printLine(`Subscribed ${eventName}.`);
                    } else {
                        this.printLine(`Event ${eventName} is already subscribed.`);
                    }
                } else {
                    this.printLine('Connection is not established.');
                }
            }
        });
        this.repl.defineCommand('unsubscribe', {
            help: 'Unsubscribe a event',
            action: (eventName) => {
                if (this.server.isOnline()) {
                    if (this.server.unsubscribe(eventName)) {
                        this.printLine(`Unsubscribed ${eventName}.`);
                    } else {
                        this.printLine(`Event ${eventName} is not subscribed.`);
                    }
                } else {
                    this.printLine('Connection is not established.');
                }
            }
        });
        this.repl.defineCommand('disconnect', {
            help: 'Disconnect from all the clients',
            action: (arg) => {
                if (this.server.isOnline()) {
                    if (arg === 'force') {
                        void this.server.disconnect(true);
                    } else {
                        let disconnected = false;
                        const timeout = setTimeout(() => {
                            if (disconnected) return;
                            this.printLine('Connection close request timeout.');
                            void this.server.disconnect(true);
                        }, 10000);
                        this.server.once('offline', () => {
                            disconnected = true;
                            clearTimeout(timeout);
                        });
                        void this.server.disconnect(false);
                    }
                } else {
                    this.printLine('Connection is not established.');
                }
            }
        });
        this.repl.defineCommand('encrypt', {
            help: 'Encrypt the connection',
            action: () => {
                if (this.server.isOnline()) {
                    void this.server.encrypt().then(() => {
                        this.printLine('Connection is encrypted.', true);
                    });
                } else {
                    this.printLine('Connection is not established.');
                }
            }
        });
    }

    doEval(cmd: string, context: Context, file: string, callback: (err: Error | null, result?: unknown) => void) {
        let result: unknown;
        this.acceptUserInput = false;
        try {
            const trimmedCmd = cmd.trim();
            if (trimmedCmd.startsWith('/') && !trimmedCmd.includes('\n')) {
                if (!this.server.isOnline() && trimmedCmd.startsWith('/connect')) {
                    this.showOfflinePrompt();
                    this.acceptUserInput = true;
                    callback(null);
                    return;
                }
                result = this.server.sendCommand(trimmedCmd.slice(1));
            } else if (trimmedCmd.length > 0) {
                result = vm.runInContext(cmd, context, {
                    filename: file
                });
            } else {
                this.acceptUserInput = true;
                callback(null);
                return;
            }
            if ((result as Promise<unknown> | undefined)?.then) {
                (result as Promise<unknown>)
                    .then(
                        (res) => {
                            callback(null, res);
                        },
                        (err: Error) => {
                            callback(err);
                        }
                    )
                    .finally(() => {
                        this.acceptUserInput = true;
                    });
            } else {
                callback(null, result);
                this.acceptUserInput = true;
            }
        } catch (err) {
            callback(err as Error);
            this.acceptUserInput = true;
        }
    }
}

function main(port: number) {
    new CommandReplServer(port);
}

main(Number(process.argv[2]) || 19134);
