import { WebSocket } from 'ws';
import { Version } from './version.js';
import { type Frame, Session, type SessionEventMap } from './base.js';
import { ClientEncryption } from './encrypt.js';
import {
    type ChatEventBody,
    ChatEventFrameType,
    type ChatSubscribeBody,
    type ChatUnsubscribeBody,
    type CommandRequestBody,
    type CommandRequestLegacyBody,
    type DataRequestPurpose,
    type EncryptRequestBody,
    type EncryptResponseBody,
    EncryptionMode,
    type EventSubscriptionBody,
    MinecraftAgentActionType,
    RequestPurpose,
    ResponsePurpose
} from './protocol.js';

export type CommandFrameBase = Frame<RequestPurpose.Command, CommandRequestBody>;
export interface CommandFrame extends CommandFrameBase {
    commandLine: string;
    respond(body: unknown): void;
    handleEncryptionHandshake(): boolean;
}

export type LegacyCommandFrameBase = Frame<RequestPurpose.Command, CommandRequestLegacyBody>;
export interface LegacyCommandFrame extends LegacyCommandFrameBase {
    commandName: string;
    overload: string;
    input: Record<string, unknown>;
    respond(body: unknown): void;
}

export type EventSubscribeFrameBase = Frame<RequestPurpose.Subscribe, EventSubscriptionBody>;
export interface SubscribeFrame extends EventSubscribeFrameBase {
    eventName: string;
}

export type EventUnsubscribeFrameBase = Frame<RequestPurpose.Unsubscribe, EventSubscriptionBody>;
export interface UnsubscribeFrame extends EventUnsubscribeFrameBase {
    eventName: string;
}

export type AgentActionFrameBase = Frame<RequestPurpose.AgentAction, CommandRequestBody>;
export interface AgentActionFrame extends AgentActionFrameBase {
    commandLine: string;
    respondCommand(body: unknown): void;
    respondAgentAction(action: MinecraftAgentActionType, actionName: string, body: unknown): void;
}

export type ChatSubscribeFrameBase = Frame<RequestPurpose.ChatMessageSubscribe, ChatSubscribeBody>;
export interface ChatSubscribeFrame extends ChatSubscribeFrameBase {
    sender?: string;
    receiver?: string;
    chatMessage?: string;
}

export type ChatUnsubscribeFrameBase = Frame<RequestPurpose.ChatMessageUnsubscribe, ChatUnsubscribeBody>;
export interface ChatUnsubscribeFrame extends ChatUnsubscribeFrameBase {
    subscribeRequestId: string;
}

export type DataRequestFrameBase<T extends string> = Frame<DataRequestPurpose<T>>;
export interface DataRequestFrame<T extends string> extends DataRequestFrameBase<T> {
    respond(body: unknown): void;
}

export interface EncryptRequest {
    cancel(): void;
}

export class WSClient extends Session {
    private eventListenMap: Map<string, boolean>;

    constructor(address: string, version?: Version) {
        super(new WebSocket(address), version);
        this.eventListenMap = new Map();
        this.setHandler(RequestPurpose.Subscribe, (frame: EventSubscribeFrameBase): undefined => {
            const { eventName } = frame.body;
            const isEventListening = this.eventListenMap.get(eventName);
            if (!isEventListening) {
                this.emit('subscribe', {
                    ...frame,
                    eventName
                } as SubscribeFrame);
                this.eventListenMap.set(eventName, true);
            }
        });
        this.setHandler(RequestPurpose.Unsubscribe, (frame: EventUnsubscribeFrameBase): undefined => {
            const { eventName } = frame.body;
            const isEventListening = this.eventListenMap.get(eventName);
            if (isEventListening) {
                this.emit('unsubscribe', {
                    ...frame,
                    eventName
                } as UnsubscribeFrame);
                this.eventListenMap.set(eventName, false);
            }
        });
        this.setHandler(RequestPurpose.Command, (frame): undefined => {
            const { requestId, body } = frame;
            const respond = (body: unknown) => {
                this.respondCommand(requestId, body);
            };
            if ((body as CommandRequestBody).commandLine) {
                const handleEncryptionHandshake = () => this.handleEncryptionHandshake(frame.requestId, commandLine);
                const { commandLine } = body as CommandRequestBody;
                this.emit('command', {
                    ...frame,
                    commandLine,
                    respond,
                    handleEncryptionHandshake
                } as CommandFrame);
            } else {
                const { name, overload, input } = body as CommandRequestLegacyBody;
                this.emit('commandLegacy', {
                    ...frame,
                    commandName: name,
                    overload,
                    input,
                    respond,
                    handleEncryptionHandshake: () => {
                        throw new Error('Not supported');
                    }
                } as LegacyCommandFrame);
            }
        });
        this.setHandler(RequestPurpose.AgentAction, (frame): undefined => {
            const { requestId, body } = frame;
            const respondCommand = (body: unknown) => {
                this.respondCommand(requestId, body);
            };
            const respondAgentAction = (action: MinecraftAgentActionType, actionName: string, body: unknown) => {
                this.respondAgentAction(requestId, action, actionName, body);
            };
            const { commandLine } = body as CommandRequestBody;
            this.emit('agentAction', {
                ...frame,
                commandLine,
                respondCommand,
                respondAgentAction
            } as AgentActionFrame);
        });
        this.setHandler(RequestPurpose.ChatMessageSubscribe, (frame): undefined => {
            const { sender, receiver, message } = frame.body as ChatSubscribeBody;
            this.emit('chatSubscribe', {
                ...frame,
                sender,
                receiver,
                chatMessage: message
            } as ChatSubscribeFrame);
        });
        this.setHandler(RequestPurpose.ChatMessageUnsubscribe, (frame): undefined => {
            const { requestId } = frame.body as ChatUnsubscribeBody;
            this.emit('chatUnsubscribe', {
                ...frame,
                subscribeRequestId: requestId
            } as ChatUnsubscribeFrame);
        });
        this.setHandler(RequestPurpose.EncryptConnection, (frame): undefined => {
            const { requestId, body } = frame;
            const { mode, publicKey, salt } = body as EncryptRequestBody;
            let cancelled: true | undefined;
            let completed: true | undefined;
            const cancel = () => {
                if (completed) {
                    throw new Error('Cannot cancel a completed encrypt request.');
                }
                cancelled = true;
            };
            const event = { cancel } as EncryptRequest;
            this.emit('encryptRequest', event);
            if (!cancelled) {
                const keyExchangeResult = this.handleKeyExchange(mode as EncryptionMode, publicKey, salt);
                this.sendEncryptResponse(requestId, keyExchangeResult.publicKey);
                keyExchangeResult.complete();
                completed = true;
            }
        });
    }

    handleKeyExchange(mode: EncryptionMode, serverPubKey: string, salt: string) {
        const encryption = new ClientEncryption();
        const keyExchangeParams = encryption.beginKeyExchange();
        encryption.completeKeyExchange(mode, serverPubKey, salt);
        return {
            publicKey: keyExchangeParams.publicKey,
            complete: () => {
                this.setEncryption(encryption);
            }
        };
    }

    handleEncryptionHandshake(requestId: string, commandLine: string) {
        if (commandLine.startsWith('enableencryption ')) {
            const args = commandLine.split(' ');
            const mode = (args[3] as EncryptionMode | undefined) ?? EncryptionMode.Aes256cfb8;
            const keyExchangeResult = this.handleKeyExchange(
                mode,
                JSON.parse(args[1]) as string,
                JSON.parse(args[2]) as string
            );
            this.respondCommand(requestId, {
                publicKey: keyExchangeResult.publicKey,
                statusCode: 0
            });
            keyExchangeResult.complete();
            return true;
        }
        return false;
    }

    sendError(statusCode?: number, statusMessage?: string, requestId?: string) {
        this.sendFrame(
            ResponsePurpose.Error,
            {
                statusCode,
                statusMessage
            },
            requestId
        );
    }

    sendEvent(eventName: string, body: Record<string, unknown>) {
        if (this.version >= Version.V1_1_0) {
            this.sendFrame(ResponsePurpose.Event, body, undefined, { eventName });
        } else {
            this.sendFrame(ResponsePurpose.Event, {
                ...body,
                eventName
            });
        }
    }

    publishEvent(eventName: string, body: Record<string, unknown>) {
        const isEventListening = this.eventListenMap.get(eventName);
        if (isEventListening) {
            this.sendEvent(eventName, body);
        }
    }

    respondCommand(requestId: string, body: unknown) {
        this.sendFrame(ResponsePurpose.Command, body, requestId);
    }

    respondAgentAction(requestId: string, action: MinecraftAgentActionType, actionName: string, body: unknown) {
        this.sendFrame(ResponsePurpose.AgentAction, body, requestId, { action, actionName });
    }

    sendChat(requestId: string, type: ChatEventFrameType, sender: string, receiver: string, message: string) {
        this.sendFrame(ResponsePurpose.ChatMessage, { type, sender, receiver, message } as ChatEventBody, requestId);
    }

    setDataResponser<T extends string = string>(dataType: T, responser: (frame: DataRequestFrame<T>) => void) {
        this.setHandler(`data:${dataType}`, (frame) => {
            const respond = (body: unknown) => {
                this.sendDataResponse(frame.requestId, dataType, 0, body);
            };
            responser({
                ...frame,
                respond
            });
            return true;
        });
    }

    clearDataResponser(dataType: string) {
        this.clearHandler(`data:${dataType}`);
    }

    sendDataResponse(requestId: string, dataType: string, type: number, body: unknown) {
        this.sendFrame(ResponsePurpose.Data, body, requestId, { dataType, type });
    }

    sendEncryptResponse(requestId: string, publicKey: string, body?: Record<string, unknown>) {
        this.sendFrame(ResponsePurpose.EncryptConnection, { ...body, publicKey } as EncryptResponseBody, requestId);
    }

    disconnect() {
        this.socket.close();
    }
}

export interface WSClientEventMap extends SessionEventMap {
    subscribe: (event: SubscribeFrame) => void;
    unsubscribe: (event: UnsubscribeFrame) => void;
    command: (event: CommandFrame) => void;
    commandLegacy: (event: LegacyCommandFrame) => void;
    agentAction: (event: AgentActionFrame) => void;
    chatSubscribe: (event: ChatSubscribeFrame) => void;
    chatUnsubscribe: (event: ChatUnsubscribeFrame) => void;
    encryptRequest: (event: EncryptRequest) => void;
}

/* eslint-disable */
export interface WSClient {
    on(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    once(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    off(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    addListener(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    removeListener(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    emit(eventName: 'subscribe', event: SubscribeFrame): boolean;
    on(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    once(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    off(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    addListener(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    removeListener(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    emit(eventName: 'unsubscribe', event: UnsubscribeFrame): boolean;
    on(eventName: 'command', listener: (event: CommandFrame) => void): this;
    once(eventName: 'command', listener: (event: CommandFrame) => void): this;
    off(eventName: 'command', listener: (event: CommandFrame) => void): this;
    addListener(eventName: 'command', listener: (event: CommandFrame) => void): this;
    removeListener(eventName: 'command', listener: (event: CommandFrame) => void): this;
    emit(eventName: 'command', event: CommandFrame): boolean;
    on(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    once(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    off(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    addListener(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    removeListener(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    emit(eventName: 'commandLegacy', event: LegacyCommandFrame): boolean;
    on(eventName: 'agentAction', listener: (event: AgentActionFrame) => void): this;
    once(eventName: 'agentAction', listener: (event: AgentActionFrame) => void): this;
    off(eventName: 'agentAction', listener: (event: AgentActionFrame) => void): this;
    addListener(eventName: 'agentAction', listener: (event: AgentActionFrame) => void): this;
    removeListener(eventName: 'agentAction', listener: (event: AgentActionFrame) => void): this;
    emit(eventName: 'agentAction', event: AgentActionFrame): boolean;
    on(eventName: 'chatSubscribe', listener: (event: ChatSubscribeFrame) => void): this;
    once(eventName: 'chatSubscribe', listener: (event: ChatSubscribeFrame) => void): this;
    off(eventName: 'chatSubscribe', listener: (event: ChatSubscribeFrame) => void): this;
    addListener(eventName: 'chatSubscribe', listener: (event: ChatSubscribeFrame) => void): this;
    removeListener(eventName: 'chatSubscribe', listener: (event: ChatSubscribeFrame) => void): this;
    emit(eventName: 'chatSubscribe', event: ChatSubscribeFrame): boolean;
    on(eventName: 'chatUnsubscribe', listener: (event: ChatUnsubscribeFrame) => void): this;
    once(eventName: 'chatUnsubscribe', listener: (event: ChatUnsubscribeFrame) => void): this;
    off(eventName: 'chatUnsubscribe', listener: (event: ChatUnsubscribeFrame) => void): this;
    addListener(eventName: 'chatUnsubscribe', listener: (event: ChatUnsubscribeFrame) => void): this;
    removeListener(eventName: 'chatUnsubscribe', listener: (event: ChatUnsubscribeFrame) => void): this;
    emit(eventName: 'chatUnsubscribe', event: ChatUnsubscribeFrame): boolean;
    on(eventName: 'encryptRequest', listener: (event: EncryptRequest) => void): this;
    once(eventName: 'encryptRequest', listener: (event: EncryptRequest) => void): this;
    off(eventName: 'encryptRequest', listener: (event: EncryptRequest) => void): this;
    addListener(eventName: 'encryptRequest', listener: (event: EncryptRequest) => void): this;
    removeListener(eventName: 'encryptRequest', listener: (event: EncryptRequest) => void): this;
    emit(eventName: 'encryptRequest', event: EncryptRequest): boolean;

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
