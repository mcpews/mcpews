import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { implementName, ServerEncryption } from './encrypt.js';
import { MinecraftCommandVersion, Version } from './version.js';
import { Frame, Session, SessionEventMap } from './base.js';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import {
    ChatEventBody,
    ChatEventFrameType,
    ChatSubscribeBody,
    ChatUnsubscribeBody,
    CommandRequestBody,
    CommandRequestLegacyBody,
    CommandResponseBody,
    DataFrameHeader,
    EncryptRequestBody,
    EncryptResponseBody,
    EncryptionMode,
    ErrorBody,
    EventBody,
    EventHeader,
    EventResponsePurposes,
    EventSubscriptionBody,
    MinecraftAgentActionResponseHeader,
    MinecraftAgentActionType,
    MinecraftBlockData,
    MinecraftDataType,
    MinecraftItemData,
    MinecraftMobData,
    ResponsePurpose
} from './protocol.js';

export type CommandResponseFrameBase<B extends CommandResponseBody = CommandResponseBody> = Frame<
    ResponsePurpose.Command,
    B
>;
export type CommandResponseFrame<B extends CommandResponseBody = CommandResponseBody> = CommandResponseFrameBase<B>;

export type ErrorFrameBase = Frame<ResponsePurpose.Error, ErrorBody>;
export type ErrorFrame = ErrorFrameBase;
export class ClientError extends Error {
    frame: ErrorFrame;
    requestId: string;
    statusCode?: number;
    statusMessage?: string;

    constructor(frame: ErrorFrame) {
        const { statusMessage, statusCode } = frame.body;
        super(statusMessage);
        this.frame = frame;
        this.requestId = frame.requestId;
        this.statusCode = statusCode;
        this.statusMessage = statusMessage;
    }
}

export type EventFrameBase<B extends EventBody = EventBody> = Frame<EventResponsePurposes, B, EventHeader>;
export interface EventFrame<B extends EventBody = EventBody> extends EventFrameBase<B> {
    eventName: string;
}

export type MinecraftAgentActionResponseFrameBase<B = unknown> = Frame<
    ResponsePurpose.AgentAction,
    B,
    MinecraftAgentActionResponseHeader
>;
export interface MinecraftAgentActionResponseFrame<B = unknown> extends MinecraftAgentActionResponseFrameBase<B> {
    action: MinecraftAgentActionType;
    actionName: string;
}

export type ChatEventFrameBase = Frame<
    ResponsePurpose.ChatMessage,
    ChatEventBody,
    EventHeader<ResponsePurpose.ChatMessage>
>;
export interface ChatEventFrame extends ChatEventFrameBase {
    eventName: string;
    chatMessage: string;
    chatType: ChatEventFrameType;
    sender: string;
    receiver: string;
}

export type DataFrameBase<Name extends string = string, ReturnType = unknown> = Frame<
    ResponsePurpose.Data,
    ReturnType,
    DataFrameHeader<Name>
>;
export interface DataFrame<Name extends string, ReturnType> extends DataFrameBase<Name, ReturnType> {
    dataType: Name;
}

export type EncryptResponseFrameBase = Frame<ResponsePurpose.EncryptConnection, EncryptResponseBody>;
type EncryptResponseFrameBaseLegacy = Frame<ResponsePurpose.Command, EncryptResponseBody>;

type SemVer = string | [number, number, number];
export type CommandVersion = MinecraftCommandVersion | SemVer;

export class ServerSession extends Session {
    server: WSServer;
    exchangingKey: boolean;
    private eventListeners: Map<string, Set<(frame: EventFrame) => void>>;
    private chatResponsers: Set<string>;

    constructor(server: WSServer, socket: WebSocket) {
        super(socket, server.version);
        this.server = server;
        this.eventListeners = new Map();
        this.chatResponsers = new Set();
        this.exchangingKey = false;
        const eventHandler = (frame: EventFrameBase) => {
            const eventName = frame.header.eventName ?? frame.body.eventName ?? '';
            const listeners = this.eventListeners.get(eventName);
            const eventFrame = {
                ...frame,
                eventName
            } as EventFrame;
            if (listeners) {
                const listenersCopy = new Set(listeners);
                listenersCopy.forEach((e) => {
                    try {
                        e.call(this, eventFrame);
                    } catch (err) {
                        this.emit('error', err as Error);
                    }
                });
            } else {
                this.emit('event', eventFrame);
            }
            return false;
        };
        this.setHandler(ResponsePurpose.Event as EventResponsePurposes, eventHandler);
        this.setHandler(ResponsePurpose.ChatMessage as EventResponsePurposes, eventHandler);
        this.setHandler(ResponsePurpose.Command, (frame: CommandResponseFrame) => {
            this.emit('commandResponse', frame);
            return false;
        });
        this.setHandler(ResponsePurpose.Error, (frame: ErrorFrame) => {
            this.emit('clientError', new ClientError(frame));
            return false;
        });
    }

    enableEncryption(callback?: (session: this) => void): boolean;
    enableEncryption(mode?: EncryptionMode, callback?: (session: this) => void): boolean;
    enableEncryption(arg1?: EncryptionMode | ((session: this) => void), arg2?: (session: this) => void) {
        if (this.exchangingKey || this.encryption) {
            return false;
        }
        const encryption = new ServerEncryption();
        const keyExchangeParams = encryption.beginKeyExchange();
        const mode = typeof arg1 === 'string' ? arg1 : EncryptionMode.Aes256cfb8;
        const callback = typeof arg1 === 'function' ? arg1 : arg2;
        this.exchangingKey = true;
        if (this.version >= Version.V1_0_0) {
            const requestId = randomUUID();
            this.sendEncryptionRequest(requestId, mode, keyExchangeParams.publicKey, keyExchangeParams.salt);
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === 'ws:encrypt') {
                    const frameBase = frame as EncryptResponseFrameBase;
                    this.exchangingKey = false;
                    encryption.completeKeyExchange(mode, frameBase.body.publicKey);
                    this.setEncryption(encryption);
                    if (callback) callback.call(this, this);
                    return true;
                }
            });
        } else {
            this.sendCommand(
                [
                    'enableencryption',
                    JSON.stringify(keyExchangeParams.publicKey),
                    JSON.stringify(keyExchangeParams.salt),
                    mode
                ],
                (frame) => {
                    const frameBase = frame as EncryptResponseFrameBaseLegacy;
                    this.exchangingKey = false;
                    encryption.completeKeyExchange(mode, frameBase.body.publicKey);
                    this.setEncryption(encryption);
                    if (callback) callback.call(this, this);
                }
            );
        }
        return true;
    }

    subscribeRaw(eventName: string) {
        this.sendFrame('subscribe', { eventName } as EventSubscriptionBody);
    }

    subscribe<B extends EventBody = EventBody>(eventName: string, callback: (frame: EventFrame<B>) => void) {
        let listeners = this.eventListeners.get(eventName);
        if (!listeners) {
            listeners = new Set();
            this.eventListeners.set(eventName, listeners);
            this.subscribeRaw(eventName);
        }
        listeners.add(callback as (frame: EventFrame) => void);
    }

    unsubscribeRaw(eventName: string) {
        this.sendFrame('unsubscribe', { eventName } as EventSubscriptionBody);
    }

    unsubscribe<B extends EventBody = EventBody>(eventName: string, callback: (frame: EventFrame<B>) => void) {
        const listeners = this.eventListeners.get(eventName);
        if (!listeners) {
            return;
        }
        listeners.delete(callback as (frame: EventFrame) => void);
        if (listeners.size === 0) {
            this.eventListeners.delete(eventName);
            this.unsubscribeRaw(eventName);
        }
    }

    sendCommandRaw(requestId: string, command: string | string[], version?: CommandVersion) {
        this.sendFrame(
            'commandRequest',
            {
                version: version ?? MinecraftCommandVersion.Initial,
                commandLine: Array.isArray(command) ? command.join(' ') : command,
                origin: {
                    type: 'player'
                }
            } as CommandRequestBody,
            requestId
        );
    }

    sendCommand<B extends CommandResponseBody = CommandResponseBody>(
        command: string | string[],
        callback?: (frame: CommandResponseFrame<B>) => void
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === 'commandResponse') {
                    callback.call(this, frame as CommandResponseFrame<B>);
                    return true;
                }
            });
        }
        this.sendCommandRaw(requestId, command);
        return requestId;
    }

    sendCommandLegacyRaw(requestId: string, commandName: string, overload: string, input: Record<string, unknown>) {
        this.sendFrame(
            'commandRequest',
            {
                version: MinecraftCommandVersion.Initial,
                name: commandName,
                overload,
                input,
                origin: { type: 'player' }
            } as CommandRequestLegacyBody,
            requestId
        );
    }

    sendCommandLegacy<B extends CommandResponseBody = CommandResponseBody>(
        commandName: string,
        overload: string,
        input: Record<string, unknown>,
        callback?: (frame: CommandResponseFrame<B>) => void
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === 'commandResponse') {
                    callback.call(this, frame as CommandResponseFrame<B>);
                    return true;
                }
            });
        }
        this.sendCommandLegacyRaw(requestId, commandName, overload, input);
        return requestId;
    }

    sendAgentCommandRaw(requestId: string, agentCommand: string | string[], version?: CommandVersion) {
        this.sendFrame(
            'action:agent',
            {
                version: version ?? MinecraftCommandVersion.Initial,
                commandLine: Array.isArray(agentCommand) ? agentCommand.join(' ') : agentCommand
            } as CommandRequestBody,
            requestId
        );
    }

    sendAgentCommand<B = unknown>(
        command: string | string[],
        callback?: (frame: MinecraftAgentActionResponseFrame<B>) => void
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === 'action:agent') {
                    const { action, actionName } = frame.header;
                    const agentActionFrame = {
                        ...frame,
                        action,
                        actionName
                    } as MinecraftAgentActionResponseFrame<B>;
                    callback.call(this, agentActionFrame);
                    return true;
                }
            });
        }
        this.sendAgentCommandRaw(requestId, command);
        return requestId;
    }

    cancelCommandRequest(requestId: string) {
        return this.clearResponser(requestId);
    }

    subscribeChatRaw(requestId: string, sender?: string | null, receiver?: string | null, message?: string | null) {
        this.sendFrame('chat:subscribe', { sender, receiver, message } as ChatSubscribeBody, requestId);
    }

    subscribeChat(
        sender?: string | null,
        receiver?: string | null,
        message?: string | null,
        callback?: (frame: ChatEventFrame) => void
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame): undefined => {
                if (frame.purpose === 'chat') {
                    const frameBase = frame as ChatEventFrameBase;
                    const eventName = frameBase.header.eventName ?? frameBase.body.eventName ?? '';
                    const { sender, receiver, message: chatMessage, type: chatType } = frameBase.body;
                    const chatFrame = {
                        ...frameBase,
                        eventName,
                        sender,
                        receiver,
                        chatMessage,
                        chatType
                    } as ChatEventFrame;
                    callback.call(this, chatFrame);
                }
            });
            this.chatResponsers.add(requestId);
        }
        this.subscribeChatRaw(requestId, sender, receiver, message);
        return requestId;
    }

    unsubscribeChatRaw(requestId?: string) {
        this.sendFrame('chat:unsubscribe', { requestId } as ChatUnsubscribeBody);
    }

    unsubscribeChat(requestId: string) {
        if (this.chatResponsers.delete(requestId)) {
            this.unsubscribeChatRaw(requestId);
            this.clearResponser(requestId);
        }
    }

    unsubscribeChatAll() {
        this.unsubscribeChatRaw();
        this.chatResponsers.forEach((requestId) => this.clearResponser(requestId));
        this.chatResponsers.clear();
    }

    fetchDataRaw(requestId: string, dataType: string) {
        this.sendFrame(`data:${dataType}`, null, requestId);
    }

    fetchData(
        dataType: MinecraftDataType.Block,
        callback?: (frame: DataFrame<MinecraftDataType.Block, MinecraftBlockData[]>) => void
    ): string;
    fetchData(
        dataType: MinecraftDataType.Item,
        callback?: (frame: DataFrame<MinecraftDataType.Item, MinecraftItemData[]>) => void
    ): string;
    fetchData(
        dataType: MinecraftDataType.Mob,
        callback?: (frame: DataFrame<MinecraftDataType.Mob, MinecraftMobData[]>) => void
    ): string;
    fetchData<Name extends string, ReturnType>(
        dataType: Name,
        callback?: (frame: DataFrame<Name, ReturnType>) => void
    ): string;
    fetchData<Name extends string, ReturnType>(
        dataType: Name,
        callback?: (frame: DataFrame<Name, ReturnType>) => void
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === 'data') {
                    const frameBase = frame as DataFrameBase;
                    const dataFrame = {
                        ...frameBase,
                        dataType: ''
                    } as DataFrame<Name, ReturnType>;
                    callback.call(this, dataFrame);
                    return true;
                }
            });
        }
        this.fetchDataRaw(requestId, dataType);
        return requestId;
    }

    sendEncryptionRequest(requestId: string, mode: EncryptionMode | number, publicKey: string, salt: string) {
        this.sendFrame('ws:encrypt', { mode, publicKey, salt } as EncryptRequestBody, requestId);
    }

    disconnect(force?: boolean) {
        if (force) {
            this.socket.close();
        } else {
            this.sendCommand('closewebsocket');
        }
    }
}

export interface ServerSessionEventMap extends SessionEventMap {
    event: (frame: EventFrame) => void;
    commandResponse: (frame: CommandResponseFrame) => void;
    clientError: (error: ClientError) => void;
}

/* eslint-disable */
export interface ServerSession {
    on(eventName: 'event', listener: (frame: EventFrame) => void): this;
    once(eventName: 'event', listener: (frame: EventFrame) => void): this;
    off(eventName: 'event', listener: (frame: EventFrame) => void): this;
    addListener(eventName: 'event', listener: (frame: EventFrame) => void): this;
    removeListener(eventName: 'event', listener: (frame: EventFrame) => void): this;
    emit(eventName: 'event', frame: EventFrame): boolean;
    on(eventName: 'commandResponse', listener: (frame: CommandResponseFrame) => void): this;
    once(eventName: 'commandResponse', listener: (frame: CommandResponseFrame) => void): this;
    off(eventName: 'commandResponse', listener: (frame: CommandResponseFrame) => void): this;
    addListener(eventName: 'commandResponse', listener: (frame: CommandResponseFrame) => void): this;
    removeListener(eventName: 'commandResponse', listener: (frame: CommandResponseFrame) => void): this;
    emit(eventName: 'commandResponse', frame: CommandResponseFrame): boolean;
    on(eventName: 'clientError', listener: (error: ClientError) => void): this;
    once(eventName: 'clientError', listener: (error: ClientError) => void): this;
    off(eventName: 'clientError', listener: (error: ClientError) => void): this;
    addListener(eventName: 'clientError', listener: (error: ClientError) => void): this;
    removeListener(eventName: 'clientError', listener: (error: ClientError) => void): this;
    emit(eventName: 'clientError', error: ClientError): boolean;

    // Inherit from Session
    on(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    once(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    off(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    addListener(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    removeListener(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    emit(eventName: 'customFrame', frame: Frame): boolean;
    on(eventName: 'disconnect', listener: (session: this) => void): this;
    once(eventName: 'disconnect', listener: (session: this) => void): this;
    off(eventName: 'disconnect', listener: (session: this) => void): this;
    addListener(eventName: 'disconnect', listener: (session: this) => void): this;
    removeListener(eventName: 'disconnect', listener: (session: this) => void): this;
    emit(eventName: 'disconnect', session: this): boolean;
    on(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    once(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    off(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    addListener(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    removeListener(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    emit(eventName: 'encryptionEnabled', session: this): boolean;
    on(eventName: 'error', listener: (err: Error) => void): this;
    once(eventName: 'error', listener: (err: Error) => void): this;
    off(eventName: 'error', listener: (err: Error) => void): this;
    addListener(eventName: 'error', listener: (err: Error) => void): this;
    removeListener(eventName: 'error', listener: (err: Error) => void): this;
    emit(eventName: 'error', err: Error): boolean;
    on(eventName: 'message', listener: (frame: Frame) => void): this;
    once(eventName: 'message', listener: (frame: Frame) => void): this;
    off(eventName: 'message', listener: (frame: Frame) => void): this;
    addListener(eventName: 'message', listener: (frame: Frame) => void): this;
    removeListener(eventName: 'message', listener: (frame: Frame) => void): this;
    emit(eventName: 'message', frame: Frame): boolean;
}
/* eslint-enable */

export interface ClientConnection {
    server: WSServer;
    session: ServerSession;
    request: IncomingMessage;
}

const kSecWebsocketKey = Symbol('sec-websocket-key');

interface WithSecWebsocketKey extends IncomingMessage {
    [kSecWebsocketKey]?: string;
}

interface WebSocketServerInternal extends WebSocketServer {
    completeUpgrade(
        extensions: Record<string, unknown>,
        key: string,
        protocols: Set<string>,
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        cb: (client: WebSocket, request: IncomingMessage) => void
    ): void;
}

export class WSServer extends WebSocketServer {
    protected sessions: Set<ServerSession>;
    version: Version;

    constructor(port: number, handleClient?: (client: ClientConnection) => void) {
        super({
            port,
            handleProtocols: (protocols) => (protocols.has(implementName) ? implementName : false)
        });
        this.sessions = new Set();
        this.version = Version.V0_0_1;
        (this as WebSocketServer).on('connection', (socket: WebSocket, request: IncomingMessage) => {
            const session = new ServerSession(this, socket);
            this.sessions.add(session);
            this.emit('client', { server: this, session, request });
            socket.on('close', () => {
                this.sessions.delete(session);
            });
        });
        if (handleClient) {
            this.on('client', handleClient);
        }
    }

    // overwrite handleUpgrade to skip sec-websocket-key format test
    // minecraft pe pre-1.2 use a shorter version of sec-websocket-key
    handleUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        upgradeHead: Buffer,
        callback: (client: WebSocket, request: IncomingMessage) => void
    ): void {
        const key = request.headers['sec-websocket-key'];
        if (key && /^[+/0-9A-Za-z]{11}=$/.test(key)) {
            request.headers['sec-websocket-key'] = `skipkeytest${key}=`;
            (request as WithSecWebsocketKey)[kSecWebsocketKey] = key;
        }
        super.handleUpgrade(request, socket, upgradeHead, callback);
    }

    // same reason as above
    completeUpgrade(
        extensions: Record<string, unknown>,
        key: string,
        protocols: Set<string>,
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        cb: (client: WebSocket, request: IncomingMessage) => void
    ) {
        (WebSocketServer.prototype as WebSocketServerInternal).completeUpgrade.call(
            this,
            extensions,
            (req as WithSecWebsocketKey)[kSecWebsocketKey] ?? key,
            protocols,
            req,
            socket,
            head,
            cb
        );
    }

    broadcastCommand(command: string, callback: (frame: CommandResponseFrame) => void) {
        this.sessions.forEach((e) => {
            e.sendCommand(command, callback);
        });
    }

    broadcastSubscribe(eventName: string, callback: (frame: EventFrame) => void) {
        this.sessions.forEach((e) => {
            e.subscribe(eventName, callback);
        });
    }

    broadcastUnsubscribe(eventName: string, callback: (frame: EventFrame) => void) {
        this.sessions.forEach((e) => {
            e.unsubscribe(eventName, callback);
        });
    }

    disconnectAll(force?: boolean) {
        this.sessions.forEach((e) => {
            e.disconnect(force);
        });
    }
}

export interface WSServerEventMap {
    client: (client: ClientConnection) => void;
}

/* eslint-disable */
export interface WSServer {
    on(eventName: 'client', listener: (client: ClientConnection) => void): this;
    once(eventName: 'client', listener: (client: ClientConnection) => void): this;
    off(eventName: 'client', listener: (client: ClientConnection) => void): this;
    addListener(eventName: 'client', listener: (client: ClientConnection) => void): this;
    removeListener(eventName: 'client', listener: (client: ClientConnection) => void): this;
    emit(eventName: 'client', client: ClientConnection): boolean;

    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    off(event: string | symbol, listener: (...args: any[]) => void): this;
    addListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    emit(event: string | symbol, ...args: any[]): boolean;
}
/* eslint-enable */
