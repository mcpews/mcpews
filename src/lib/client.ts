import { WebSocket } from 'ws';
import { type ExtendEventMap, type Frame, Session, type SessionEvents } from './base.js';
import { ClientEncryption } from './encrypt.js';
import {
    type ChatEventBody,
    type ChatEventFrameType,
    type ChatSubscribeBody,
    type ChatUnsubscribeBody,
    type CommandRequestBody,
    type CommandRequestLegacyBody,
    type DataRequestPurpose,
    EncryptionMode,
    type EncryptRequestBody,
    type EncryptResponseBody,
    type EventSubscriptionBody,
    type MinecraftAgentActionType,
    RequestPurpose,
    ResponsePurpose,
} from './protocol.js';
import { Version } from './version.js';

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
    /** @deprecated Not supported */
    handleEncryptionHandshake(): boolean;
}

function isCommandFrame(frame: CommandFrameBase | LegacyCommandFrameBase): frame is CommandFrameBase {
    const body = frame.body;
    return (body as CommandRequestBody).commandLine !== undefined;
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
    subscribeRequestId?: string;
}

export type DataRequestFrameBase<T extends string> = Frame<DataRequestPurpose<T>>;
export interface DataRequestFrame<T extends string> extends DataRequestFrameBase<T> {
    respond(body: unknown): void;
}

export type EncryptRequestFrameBase = Frame<RequestPurpose.EncryptConnection, EncryptRequestBody>;
export interface EncryptRequest extends EncryptRequestFrameBase {
    cancel(): void;
}

export interface WSClientEvents extends SessionEvents {
    subscribe: [event: SubscribeFrame];
    unsubscribe: [event: UnsubscribeFrame];
    command: [event: CommandFrame];
    commandLegacy: [event: LegacyCommandFrame];
    agentAction: [event: AgentActionFrame];
    chatSubscribe: [event: ChatSubscribeFrame];
    chatUnsubscribe: [event: ChatUnsubscribeFrame];
    encryptRequest: [event: EncryptRequest];
}

export class WSClient extends (Session as ExtendEventMap<typeof Session, WSClientEvents>) {
    private eventListenMap: Map<string, boolean>;

    constructor(address: string, version?: Version) {
        super(new WebSocket(address), version);
        this.eventListenMap = new Map();
        this.setHandler(RequestPurpose.Subscribe, (frame: EventSubscribeFrameBase) => {
            const { eventName } = frame.body;
            const isEventListening = this.eventListenMap.get(eventName);
            if (!isEventListening) {
                this.emit('subscribe', {
                    ...frame,
                    eventName,
                });
                this.eventListenMap.set(eventName, true);
            }
            return false;
        });
        this.setHandler(RequestPurpose.Unsubscribe, (frame: EventUnsubscribeFrameBase) => {
            const { eventName } = frame.body;
            const isEventListening = this.eventListenMap.get(eventName);
            if (isEventListening) {
                this.emit('unsubscribe', {
                    ...frame,
                    eventName,
                });
                this.eventListenMap.set(eventName, false);
            }
            return false;
        });
        this.setHandler(RequestPurpose.Command, (frame: CommandFrameBase | LegacyCommandFrameBase) => {
            const respond = (body: unknown) => {
                this.respondCommand(frame.requestId, body);
            };
            if (isCommandFrame(frame)) {
                const handleEncryptionHandshake = () => this.handleEncryptionHandshake(frame.requestId, commandLine);
                const { commandLine } = frame.body;
                this.emit('command', {
                    ...frame,
                    commandLine,
                    respond,
                    handleEncryptionHandshake,
                });
            } else {
                const { name, overload, input } = frame.body;
                this.emit('commandLegacy', {
                    ...frame,
                    commandName: name,
                    overload,
                    input,
                    respond,
                    handleEncryptionHandshake: () => {
                        throw new Error('Not supported');
                    },
                });
            }
            return false;
        });
        this.setHandler(RequestPurpose.AgentAction, (frame: AgentActionFrameBase) => {
            const respondCommand = (body: unknown) => {
                this.respondCommand(frame.requestId, body);
            };
            const respondAgentAction = (action: MinecraftAgentActionType, actionName: string, body: unknown) => {
                this.respondAgentAction(frame.requestId, action, actionName, body);
            };
            const { commandLine } = frame.body;
            this.emit('agentAction', {
                ...frame,
                commandLine,
                respondCommand,
                respondAgentAction,
            });
            return false;
        });
        this.setHandler(RequestPurpose.ChatMessageSubscribe, (frame: ChatSubscribeFrameBase) => {
            const { sender, receiver, message } = frame.body;
            this.emit('chatSubscribe', {
                ...frame,
                sender,
                receiver,
                chatMessage: message,
            });
            return false;
        });
        this.setHandler(RequestPurpose.ChatMessageUnsubscribe, (frame: ChatUnsubscribeFrameBase) => {
            const { requestId } = frame.body;
            this.emit('chatUnsubscribe', {
                ...frame,
                subscribeRequestId: requestId,
            });
            return false;
        });
        this.setHandler(RequestPurpose.EncryptConnection, (frame: EncryptRequestFrameBase) => {
            const { mode, publicKey, salt } = frame.body;
            let cancelled: true | undefined;
            let completed: true | undefined;
            const cancel = () => {
                if (completed) {
                    throw new Error('Cannot cancel a completed encrypt request.');
                }
                cancelled = true;
            };
            this.emit('encryptRequest', {
                ...frame,
                cancel,
            });
            if (!cancelled) {
                const keyExchangeResult = this.handleKeyExchange(mode as EncryptionMode, publicKey, salt);
                this.sendEncryptResponse(frame.requestId, keyExchangeResult.publicKey);
                keyExchangeResult.complete();
                completed = true;
            }
            return false;
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
            },
        };
    }

    handleEncryptionHandshake(requestId: string, commandLine: string) {
        if (commandLine.startsWith('enableencryption ')) {
            const args = commandLine.split(' ');
            const mode = (args[3] as EncryptionMode | undefined) ?? EncryptionMode.Aes256cfb8;
            const keyExchangeResult = this.handleKeyExchange(
                mode,
                JSON.parse(args[1]) as string,
                JSON.parse(args[2]) as string,
            );
            this.respondCommand(requestId, {
                publicKey: keyExchangeResult.publicKey,
                statusCode: 0,
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
                statusMessage,
            },
            requestId,
        );
    }

    sendEvent(eventName: string, body: Record<string, unknown>) {
        if (this.version >= Version.V1_1_0) {
            this.sendFrame(ResponsePurpose.Event, body, undefined, { eventName });
        } else {
            this.sendFrame(ResponsePurpose.Event, {
                ...body,
                eventName,
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
        this.sendFrame(
            ResponsePurpose.ChatMessage,
            { type, sender, receiver, message } satisfies ChatEventBody,
            requestId,
        );
    }

    setDataResponser<T extends string = string>(dataType: T, responser: (frame: DataRequestFrame<T>) => void) {
        this.setHandler(`data:${dataType}`, (frame) => {
            const respond = (body: unknown) => {
                this.sendDataResponse(frame.requestId, dataType, 0, body);
            };
            responser({
                ...frame,
                respond,
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
        this.sendFrame(
            ResponsePurpose.EncryptConnection,
            { ...body, publicKey } satisfies EncryptResponseBody,
            requestId,
        );
    }

    disconnect() {
        this.socket.close();
    }
}
