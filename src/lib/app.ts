import EventEmitter from 'events';
import { CommandResponseFrame, EventFrame, ServerSession, WSServer } from './server.js';
import { pEvent, CancelablePromise } from 'p-event';
import { IncomingMessage } from 'http';

const ERRORCODE_MASK = 1 << 31;

export class AppSession {
    session: ServerSession;

    constructor(session: ServerSession) {
        this.session = session;
    }

    enableEncryption(): Promise<boolean> {
        return new Promise((resolve) => {
            if (
                !this.session.enableEncryption(() => {
                    resolve(true);
                })
            ) {
                resolve(false);
            }
        });
    }

    isEncrypted() {
        return this.session.isEncrypted();
    }

    on(eventName: 'Disconnect', listener: () => void): this;
    on(eventName: string, listener: (frame: EventFrame) => void): this;
    on(eventName: string, listener: (frame: EventFrame) => void): this {
        if (eventName === 'Disconnect') {
            this.session.on('disconnect', listener as () => void);
        } else {
            this.session.subscribe(eventName, listener);
        }
        return this;
    }

    once(eventName: 'Disconnect', listener: () => void): this;
    once(eventName: string, listener: (frame: EventFrame) => void): this;
    once(eventName: string, listener: (frame: EventFrame) => void): this {
        const holderListener = () => {
            // delay the unsubscribe request
        };
        const wrappedListener = (frame: EventFrame) => {
            this.off(eventName, wrappedListener);
            listener.call(this, frame);
            this.off(eventName, holderListener);
        };
        this.on(eventName, wrappedListener);
        this.on(eventName, holderListener);
        return this;
    }

    off(eventName: 'Disconnect', listener: () => void): this;
    off(eventName: string, listener: (this: this, frame: EventFrame) => void): this;
    off(eventName: string, listener: (this: this, frame: EventFrame) => void) {
        if (eventName === 'Disconnect') {
            this.session.off('disconnect', listener as () => void);
        } else {
            this.session.unsubscribe(eventName, listener);
        }
        return this;
    }

    addListener(eventName: 'Disconnect', listener: () => void): this;
    addListener(eventName: string, listener: (frame: EventFrame) => void): this;
    addListener(eventName: string, listener: (frame: EventFrame) => void): this {
        return this.on(eventName, listener);
    }

    removeListener(eventName: 'Disconnect', listener: () => void): this;
    removeListener(eventName: string, listener: (this: this, frame: EventFrame) => void): this;
    removeListener(eventName: string, listener: (this: this, frame: EventFrame) => void) {
        return this.off(eventName, listener);
    }

    waitForEvent(eventName: string, timeout?: number, filter?: (frame: EventFrame) => boolean) {
        return pEvent(this, eventName, { timeout, filter });
    }

    command(commandLine: string | string[], timeout?: number) {
        let requestId: string;
        const errorEventPromise = pEvent(this.session, [], { rejectionEvents: ['error', 'clientError'], timeout });
        const callbackPromise = new Promise((resolve: (value: CommandResponseFrame) => void, reject) => {
            requestId = this.session.sendCommand(commandLine, (event) => {
                if (!event.body.statusCode || (event.body.statusCode & ERRORCODE_MASK) === 0) {
                    resolve(event);
                } else {
                    reject(new Error(event.body.statusMessage));
                }
            });
        });
        const cancel = () => {
            this.session.cancelCommandRequest(requestId);
            errorEventPromise.cancel();
        };
        const racePromise = Promise.race([errorEventPromise as unknown as Promise<never>, callbackPromise]).finally(
            () => {
                cancel();
            }
        ) as CancelablePromise<CommandResponseFrame>;
        racePromise.cancel = cancel;
        return racePromise;
    }

    commandLegacy(commandName: string, overload: string, input: Record<string, unknown>, timeout?: number) {
        let requestId: string;
        const errorEventPromise = pEvent(this.session, [], { rejectionEvents: ['error', 'clientError'], timeout });
        const callbackPromise = new Promise((resolve: (value: CommandResponseFrame) => void, reject) => {
            requestId = this.session.sendCommandLegacy(commandName, overload, input, (event) => {
                if (!event.body.statusCode || (event.body.statusCode & ERRORCODE_MASK) === 0) {
                    resolve(event);
                } else {
                    reject(new Error(event.body.statusMessage));
                }
            });
        });
        const cancel = () => {
            this.session.cancelCommandRequest(requestId);
            errorEventPromise.cancel();
        };
        const racePromise = Promise.race([errorEventPromise as unknown as Promise<never>, callbackPromise]).finally(
            cancel
        ) as CancelablePromise<CommandResponseFrame>;
        racePromise.cancel = cancel;
        return racePromise;
    }

    disconnect(force?: boolean, timeout?: number) {
        const promise = pEvent(this.session, 'disconnect', { timeout });
        this.session.disconnect(force);
        return promise as unknown as CancelablePromise<void>;
    }
}

export class WSApp extends EventEmitter {
    server: WSServer;
    protected sessions: Set<AppSession>;

    constructor(port: number, handleSession?: (connection: AppSessionConnection) => void) {
        super();
        this.server = new WSServer(port, ({ session, request }) => {
            const appSession = new AppSession(session);
            this.sessions.add(appSession);
            this.emit('session', { app: this, session: appSession, request });
            session.on('disconnect', () => {
                this.sessions.delete(appSession);
            });
        });
        this.sessions = new Set();
        if (handleSession) {
            this.on('session', handleSession);
        }
    }

    async forEachSession(f: (session: AppSession) => void) {
        await Promise.all([...this.sessions].map(f));
    }

    async mapSession<R>(f: (session: AppSession) => R) {
        return Promise.all([...this.sessions].map(f));
    }

    waitForSession(timeout?: number) {
        return pEvent(this, 'session', { timeout });
    }

    close() {
        this.server.close();
    }
}

export interface AppSessionConnection {
    app: WSApp;
    session: AppSession;
    request: IncomingMessage;
}

export interface WSAppEventMap {
    session: (connection: AppSessionConnection) => void;
}

export interface WSApp {
    on(eventName: 'session', listener: (connection: AppSessionConnection) => void): this;
    once(eventName: 'session', listener: (connection: AppSessionConnection) => void): this;
    off(eventName: 'session', listener: (connection: AppSessionConnection) => void): this;
    addListener(eventName: 'session', listener: (connection: AppSessionConnection) => void): this;
    removeListener(eventName: 'session', listener: (connection: AppSessionConnection) => void): this;
    emit(eventName: 'session', connection: AppSessionConnection): boolean;
}
