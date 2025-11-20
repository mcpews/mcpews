import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { type ExtendEventMap, type Frame, Session, type SessionEvents } from './base.js';
import { implementName, ServerEncryption } from './encrypt.js';
import {
    type ChatEventBody,
    type ChatEventFrameType,
    type ChatSubscribeBody,
    type ChatUnsubscribeBody,
    type CommandRequestBody,
    type CommandRequestLegacyBody,
    type CommandResponseBody,
    type DataFrameHeader,
    EncryptionMode,
    type EncryptRequestBody,
    type EncryptResponseBody,
    type ErrorBody,
    type EventBody,
    type EventHeader,
    type EventResponsePurposes,
    type EventSubscriptionBody,
    type MinecraftAgentActionResponseHeader,
    type MinecraftAgentActionType,
    type MinecraftBlockData,
    type MinecraftDataType,
    type MinecraftItemData,
    type MinecraftMobData,
    RequestPurpose,
    ResponsePurpose,
} from './protocol.js';
import { MinecraftCommandVersion, Version } from './version.js';

export type CommandResponseFrame<B extends CommandResponseBody = CommandResponseBody> = Frame<
    ResponsePurpose.Command,
    B
>;

export type ErrorFrame = Frame<ResponsePurpose.Error, ErrorBody>;
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

export type AgentActionResponseFrameBase<B = unknown> = Frame<
    ResponsePurpose.AgentAction,
    B,
    MinecraftAgentActionResponseHeader
>;
export interface AgentActionResponseFrame<B = unknown> extends AgentActionResponseFrameBase<B> {
    action: MinecraftAgentActionType;
    actionName: string;
    commandResponse?: CommandResponseFrame;
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

export interface ServerSessionEvents extends SessionEvents {
    event: [frame: EventFrame];
    commandResponse: [frame: CommandResponseFrame];
    clientError: [error: ClientError];
}

export class ServerSession extends (Session as ExtendEventMap<typeof Session, ServerSessionEvents>) {
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
            const eventName = frame.header.eventName ?? frame.body.eventName;
            if (eventName !== undefined) {
                const listeners = this.eventListeners.get(eventName);
                const eventFrame = {
                    ...frame,
                    eventName,
                } as EventFrame;
                if (listeners) {
                    for (const listener of [...listeners]) {
                        try {
                            listener.call(this, eventFrame);
                        } catch (err) {
                            this.emit('error', err as Error);
                        }
                    }
                } else {
                    this.emit('event', eventFrame);
                }
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
                if (frame.purpose === ResponsePurpose.EncryptConnection) {
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
                    mode,
                ],
                (frame) => {
                    const frameBase = frame as EncryptResponseFrameBaseLegacy;
                    this.exchangingKey = false;
                    encryption.completeKeyExchange(mode, frameBase.body.publicKey);
                    this.setEncryption(encryption);
                    if (callback) callback.call(this, this);
                },
            );
        }
        return true;
    }

    subscribeRaw(eventName: string) {
        this.sendFrame(RequestPurpose.Subscribe, { eventName } as EventSubscriptionBody);
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
        this.sendFrame(RequestPurpose.Unsubscribe, { eventName } as EventSubscriptionBody);
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
            RequestPurpose.Command,
            {
                version: version ?? MinecraftCommandVersion.Initial,
                commandLine: Array.isArray(command) ? command.join(' ') : command,
                origin: {
                    type: 'player',
                },
            } as CommandRequestBody,
            requestId,
        );
    }

    sendCommand<B extends CommandResponseBody = CommandResponseBody>(
        command: string | string[],
        callback?: (frame: CommandResponseFrame<B>) => void,
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === ResponsePurpose.Command) {
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
            RequestPurpose.Command,
            {
                version: MinecraftCommandVersion.Initial,
                name: commandName,
                overload,
                input,
                origin: { type: 'player' },
            } as CommandRequestLegacyBody,
            requestId,
        );
    }

    sendCommandLegacy<B extends CommandResponseBody = CommandResponseBody>(
        commandName: string,
        overload: string,
        input: Record<string, unknown>,
        callback?: (frame: CommandResponseFrame<B>) => void,
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === ResponsePurpose.Command) {
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
            RequestPurpose.AgentAction,
            {
                version: version ?? MinecraftCommandVersion.Initial,
                commandLine: Array.isArray(agentCommand) ? agentCommand.join(' ') : agentCommand,
            } as CommandRequestBody,
            requestId,
        );
    }

    sendAgentCommand<B = unknown>(command: string | string[], callback?: (frame: AgentActionResponseFrame<B>) => void) {
        const requestId = randomUUID();
        if (callback) {
            let commandResponse: CommandResponseFrame | undefined;
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === ResponsePurpose.Command) {
                    commandResponse = frame as CommandResponseFrame;
                    return false;
                }
                if (frame.purpose === ResponsePurpose.AgentAction) {
                    const { action, actionName } = frame.header;
                    const agentActionFrame = {
                        ...frame,
                        action,
                        actionName,
                        commandResponse,
                    } as AgentActionResponseFrame<B>;
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
        this.sendFrame(
            RequestPurpose.ChatMessageSubscribe,
            { sender, receiver, message } as ChatSubscribeBody,
            requestId,
        );
    }

    subscribeChat(
        sender?: string | null,
        receiver?: string | null,
        message?: string | null,
        callback?: (frame: ChatEventFrame) => void,
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame): undefined => {
                if (frame.purpose === ResponsePurpose.ChatMessage) {
                    const frameBase = frame as ChatEventFrameBase;
                    const eventName = frameBase.header.eventName ?? frameBase.body.eventName ?? '';
                    const { sender, receiver, message: chatMessage, type: chatType } = frameBase.body;
                    const chatFrame = {
                        ...frameBase,
                        eventName,
                        sender,
                        receiver,
                        chatMessage,
                        chatType,
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
        this.sendFrame(RequestPurpose.ChatMessageUnsubscribe, { requestId } as ChatUnsubscribeBody);
    }

    unsubscribeChat(requestId: string) {
        if (this.chatResponsers.delete(requestId)) {
            this.unsubscribeChatRaw(requestId);
            this.clearResponser(requestId);
        }
    }

    unsubscribeChatAll() {
        this.unsubscribeChatRaw();
        for (const requestId of this.chatResponsers) {
            this.clearResponser(requestId);
        }
        this.chatResponsers.clear();
    }

    fetchDataRaw(requestId: string, dataType: string) {
        this.sendFrame(`data:${dataType}`, null, requestId);
    }

    fetchData(
        dataType: MinecraftDataType.Block,
        callback?: (frame: DataFrame<MinecraftDataType.Block, MinecraftBlockData[]>) => void,
    ): string;
    fetchData(
        dataType: MinecraftDataType.Item,
        callback?: (frame: DataFrame<MinecraftDataType.Item, MinecraftItemData[]>) => void,
    ): string;
    fetchData(
        dataType: MinecraftDataType.Mob,
        callback?: (frame: DataFrame<MinecraftDataType.Mob, MinecraftMobData[]>) => void,
    ): string;
    fetchData<Name extends string, ReturnType>(
        dataType: Name,
        callback?: (frame: DataFrame<Name, ReturnType>) => void,
    ): string;
    fetchData<Name extends string, ReturnType>(
        dataType: Name,
        callback?: (frame: DataFrame<Name, ReturnType>) => void,
    ) {
        const requestId = randomUUID();
        if (callback) {
            this.setResponser(requestId, (frame) => {
                if (frame.purpose === ResponsePurpose.Data) {
                    const frameBase = frame as DataFrameBase;
                    const dataFrame = {
                        ...frameBase,
                        dataType: frameBase.header.dataType,
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
        this.sendFrame(RequestPurpose.EncryptConnection, { mode, publicKey, salt } as EncryptRequestBody, requestId);
    }

    disconnect(force?: boolean) {
        if (force) {
            this.socket.close();
        } else {
            this.sendCommand('closewebsocket');
        }
    }
}

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
        cb: (client: WebSocket, request: IncomingMessage) => void,
    ): void;
}

class MinecraftWebSocketServer extends WebSocketServer {
    constructor(port: number) {
        super({
            port,
            handleProtocols: (protocols) => (protocols.has(implementName) ? implementName : false),
        });
    }

    // overwrite handleUpgrade to skip sec-websocket-key format test
    // minecraft pe pre-1.2 use a shorter version of sec-websocket-key
    handleUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        upgradeHead: Buffer,
        callback: (client: WebSocket, request: IncomingMessage) => void,
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
        cb: (client: WebSocket, request: IncomingMessage) => void,
    ) {
        (WebSocketServer.prototype as WebSocketServerInternal).completeUpgrade.call(
            this,
            extensions,
            (req as WithSecWebsocketKey)[kSecWebsocketKey] ?? key,
            protocols,
            req,
            socket,
            head,
            cb,
        );
    }
}

export interface WSServerEvents {
    client: [client: ClientConnection];
}

export class WSServer extends EventEmitter<WSServerEvents> {
    server: WebSocketServer;
    sessions: Set<ServerSession>;
    version: Version;

    constructor(port: number, handleClient?: (client: ClientConnection) => void) {
        super();
        this.server = new MinecraftWebSocketServer(port);
        this.sessions = new Set();
        this.version = Version.V0_0_1;
        this.server.on('connection', (socket, request) => {
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

    broadcastCommand(command: string, callback: (frame: CommandResponseFrame) => void) {
        for (const session of this.sessions) {
            session.sendCommand(command, callback);
        }
    }

    broadcastSubscribe(eventName: string, callback: (frame: EventFrame) => void) {
        for (const session of this.sessions) {
            session.subscribe(eventName, callback);
        }
    }

    broadcastUnsubscribe(eventName: string, callback: (frame: EventFrame) => void) {
        for (const session of this.sessions) {
            session.unsubscribe(eventName, callback);
        }
    }

    disconnectAll(force?: boolean) {
        for (const session of this.sessions) {
            session.disconnect(force);
        }
    }

    close(cb?: (err?: Error) => void) {
        this.server.close(cb);
    }
}
