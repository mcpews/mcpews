import { IncomingMessage } from "http";

declare class TypedEventEmitter<EventMap> {
    on<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    once<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    off<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    removeAllListeners<E extends keyof EventMap>(event: E): this;
    listeners<E extends keyof EventMap>(event: E): EventMap[E][];
    rawListeners<E extends keyof EventMap>(event: E): EventMap[E][];
    emit<E extends keyof EventMap>(event: E, ...args: any[]): boolean;
    listenerCount<E extends keyof EventMap>(event: E): number;
    prependListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    prependOnceListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    eventNames(): (keyof EventMap)[];
}

interface SessionEventMap {
    encryptionEnabled: (session: Session) => void;
    error: (error: Error) => void;
    event: (eventName: string, body: any, message: any, session: Session) => void;
    commandResponse: (requestId: string, body: any, message: any, session: Session) => void;
    mcError: (statusCode: number, statusMessage: string, body: any, message: any, session: Session) => void;
    customFrame: (messagePurpose: string, body: any, header: any, message: any, session: Session) => void;
    message: (message: any, session: Session) => void;
    disconnect: (session: Session) => void;
}

declare class Session extends TypedEventEmitter<SessionEventMap> {
    server: WSServer;

    enableEncryption(callback?: (session: Session) => void): void;
    isEncrypted(): boolean;
    sendMessage(message: any): void;
    sendFrame(messagePurpose: string, body: any, uuid: string): void;
    subscribeRaw(event: string): void;
    subscribe(event: string, callback: (body: any, message: any, session: Session) => void): void;
    unsubscribeRaw(event: string): void;
    unsubscribe(event: string, callback: (body: any, message: any, session: Session) => void): void;
    sendCommandRaw(requestId: string, command: string): void;
    sendCommand(command: string | Array<string>, callback?: (body: any, message: any, session: Session) => void): void;
    sendCommandLegacyRaw(requestId: string, commandName: string, overload: string, input: any): void;
    sendCommandLegacy(commandName: string, overload: string, input: any, callback?: (body: any, message: any, session: Session) => void): void;
    disconnect(force?: boolean): void;
}

interface WSServerEventMap {
    client: (this: WSServer, session: Session, req: IncomingMessage) => void;
}

export declare class WSServer extends TypedEventEmitter<WSServerEventMap> {
    constructor(port: number, handleClient?: (session: Session, req: IncomingMessage) => void);

    sessions: Set<Session>;

    broadcastCommand(command: string, callback?: (body: any, message: any, session: Session) => void): void;
    broadcastSubscribe(event: string, callback: (body: any, message: any, session: Session) => void): void;
    broadcastUnsubscribe(event: string, callback: (body: any, message: any, session: Session) => void): void;
    disconnectAll(force?: boolean): void;
}

interface WSClientEventMap {
    encryptionEnabled: (client: WSClient) => void;
    subscribe: (eventName: string, body: any, message: any, client: WSClient) => void;
    unsubscribe: (eventName: string, body: any, message: any, client: WSClient) => void;
    command: (requestId: string, commandLine: string, body: any, message: any, client: WSClient) => void;
    commandLegacy: (requestId: string, commandName: string, overload: string, input: any, body: any, message: any, client: WSClient) => void;
    customFrame: (messagePurpose: string, body: any, header: any, message: any, client: WSClient) => void;
    message: (message: any, client: WSClient) => void;
    disconnect: (client: WSClient) => void;
}

export declare class WSClient extends TypedEventEmitter<WSClientEventMap> {
    constructor(address: string);
    handleEncryptionHandshake(requestId: string, commandLine: string): boolean;
    isEncrypted(): boolean;
    sendMessage(message: any): void;
    sendFrame(messagePurpose: string, body: any, uuid: string): void;
    sendError(statusCode: number, statusMessage: string): void;
    sendEvent(eventName: string, body: any): void;
    emitEvent(eventName: string, body: any): void;
    respondCommand(requestId: string, body: any): void;
    disconnect(): void;
}

declare class AppSession {
    enableEncryption(): Promise<void>;
    isEncrypted(): boolean;
    on(eventName: string, listener: (this: AppSession, body: any) => void): this;
    once(eventName: string, listener: (this: AppSession, body: any) => void): this;
    off(eventName: string, listener: (this: AppSession, body: any) => void): this;
    addListener(eventName: string, listener: (this: AppSession, body: any) => void): this;
    removeListener(eventName: string, listener: (this: AppSession, body: any) => void): this;
    waitForEvent(eventName: string, timeout?: number): Promise<any>;
    command(command: string | Array<string>): Promise<any>;
    commandLegacy(commandName: string, overload: string, input: any): Promise<any>;
    disconnect(timeout?: number): Promise<void>;
}

interface WSAppEventMap {
    session: (session: AppSession) => void;
    error: (error: Error) => void;
}

export declare class WSApp extends TypedEventEmitter<WSAppEventMap> {
    constructor(port: number);

    waitForSession(timeout?: number): Promise<AppSession>;
}