import { supabase } from '../../../lib/supabaseClient';
import { fetchAllRows } from '../../../lib/utils/fetchAll';

export interface UnreadMessageInfo {
    userId: string;
    count: number;
    lastMessageTime: Date;
}

export interface MessageSubscriptionCallback {
    (userId: string, count: number, lastMessageTime: Date): void;
}

interface CachedMessageData {
    unreadCount: number;
    lastMessageTime: string;
    lastResponseTime?: string; // Час останньої відповіді
    timestamp: number; // Час кешування
}

class MessageService {
    private subscriptions: Set<MessageSubscriptionCallback> = new Set();
    private unreadCounts: Map<string, number> = new Map();
    private lastMessageTimes: Map<string, Date> = new Map();
    private lastResponseTimes: Map<string, Date> = new Map(); // Нове поле
    private realtimeSubscription: any = null;
    private readonly CACHE_KEY = 'messageService_cache';
    private readonly CACHE_EXPIRY = 5 * 60 * 1000; // 5 хвилин

    constructor() {
        this.loadFromCache();
    }

    // Завантаження даних з localStorage
    private loadFromCache(): void {
        try {
            const cached = localStorage.getItem(this.CACHE_KEY);
            if (!cached) return;

            const data: Record<string, CachedMessageData> = JSON.parse(cached);
            const now = Date.now();

            Object.entries(data).forEach(([userId, cachedData]) => {
                // Перевіряємо, чи не застарів кеш
                if (now - cachedData.timestamp < this.CACHE_EXPIRY) {
                    this.unreadCounts.set(userId, cachedData.unreadCount);
                    this.lastMessageTimes.set(userId, new Date(cachedData.lastMessageTime));
                    
                    if (cachedData.lastResponseTime) {
                        this.lastResponseTimes.set(userId, new Date(cachedData.lastResponseTime));
                    }
                }
            });

            console.log('Loaded message cache for', Object.keys(data).length, 'users');
        } catch (error) {
            console.error('Error loading message cache:', error);
            this.clearCache();
        }
    }

    // Збереження даних в localStorage
    private saveToCache(): void {
        try {
            const data: Record<string, CachedMessageData> = {};
            const now = Date.now();

            this.unreadCounts.forEach((count, userId) => {
                const lastMessageTime = this.lastMessageTimes.get(userId);
                const lastResponseTime = this.lastResponseTimes.get(userId);

                if (lastMessageTime) {
                    data[userId] = {
                        unreadCount: count,
                        lastMessageTime: lastMessageTime.toISOString(),
                        lastResponseTime: lastResponseTime?.toISOString(),
                        timestamp: now
                    };
                }
            });

            localStorage.setItem(this.CACHE_KEY, JSON.stringify(data));
            console.log('Saved message cache for', Object.keys(data).length, 'users');
        } catch (error) {
            console.error('Error saving message cache:', error);
        }
    }

    // Підписка на зміни повідомлень в реальному часі
    subscribeToMessages(callback: MessageSubscriptionCallback) {
        this.subscriptions.add(callback);
        
        if (this.subscriptions.size === 1) {
            this.startRealtimeSubscription();
        }
        
        return () => {
            this.subscriptions.delete(callback);
            if (this.subscriptions.size === 0) {
                this.stopRealtimeSubscription();
            }
        };
    }

    private startRealtimeSubscription() {
        this.realtimeSubscription = supabase
            .channel('messages')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'messages'
                },
                (payload) => {
                    console.log('Message change detected:', payload);
                    this.handleMessageChange(payload);
                }
            )
            .subscribe();
    }

    private stopRealtimeSubscription() {
        if (this.realtimeSubscription) {
            supabase.removeChannel(this.realtimeSubscription);
            this.realtimeSubscription = null;
        }
    }

    private async handleMessageChange(payload: any) {
        const { eventType, new: newRecord, old: oldRecord } = payload;
        
        if (eventType === 'INSERT' && newRecord.content && newRecord.end_user_id) {
            // Нове повідомлення від користувача
            console.log('New user message detected:', newRecord);
            await this.updateUnreadCount(newRecord.end_user_id.toString());
        } else if (eventType === 'UPDATE' && newRecord.end_user_id) {
            // Оновлення повідомлення (додано response або змінено)
            console.log('Message updated:', { old: oldRecord, new: newRecord });
            
            // Якщо додано відповідь, оновлюємо час останньої відповіді
            if (newRecord.response && (!oldRecord.response || oldRecord.response !== newRecord.response)) {
                this.lastResponseTimes.set(newRecord.end_user_id.toString(), new Date());
            }
            
            await this.updateUnreadCount(newRecord.end_user_id.toString());
        }
    }

    // Отримання кількості непрочитаних повідомлень для користувача
    async getUnreadCount(userId: string): Promise<number> {
        try {
            // Paginate to count unread messages across the user's full history
            // (a single Supabase request is capped at 1000 rows by default).
            const messages = await fetchAllRows((from, to) =>
                supabase
                    .from('messages')
                    .select('id, content, response, time')
                    .eq('end_user_id', parseInt(userId))
                    .not('content', 'is', null)
                    .order('time', { ascending: true })
                    .range(from, to)
            );

            if (!messages || messages.length === 0) {
                this.unreadCounts.set(userId, 0);
                this.saveToCache();
                return 0;
            }

            let unreadCount = 0;
            let lastMessageTime = new Date(messages[0].time);
            const lastResponseTime = this.lastResponseTimes.get(userId);

            for (const message of messages) {
                const messageTime = new Date(message.time);
                if (messageTime > lastMessageTime) {
                    lastMessageTime = messageTime;
                }

                // Рахуємо тільки повідомлення з content але без response
                // І тільки ті, що прийшли після останньої відправленої відповіді
                if (message.content && (!message.response || message.response.trim() === '')) {
                    if (!lastResponseTime || messageTime > lastResponseTime) {
                        unreadCount++;
                    }
                }
            }

            this.unreadCounts.set(userId, unreadCount);
            this.lastMessageTimes.set(userId, lastMessageTime);
            this.saveToCache();

            console.log(`Unread count for user ${userId}: ${unreadCount}`);
            return unreadCount;
        } catch (error) {
            console.error('Error getting unread count for user', userId, ':', error);
            return 0;
        }
    }

    // Отримання непрочитаних повідомлень для всіх користувачів
    async getAllUnreadCounts(userIds: string[]): Promise<Record<string, UnreadMessageInfo>> {
        const result: Record<string, UnreadMessageInfo> = {};
        
        try {
            if (userIds.length === 0) {
                return result;
            }

            // Paginate so unread counts cover every user's full history
            // (a single Supabase request is capped at 1000 rows by default).
            const messages = await fetchAllRows((from, to) =>
                supabase
                    .from('messages')
                    .select('id, end_user_id, content, response, time')
                    .in('end_user_id', userIds.map(id => parseInt(id)))
                    .not('content', 'is', null)
                    .order('time', { ascending: true })
                    .range(from, to)
            );

            const messagesByUser: Record<string, any[]> = {};
            
            messages?.forEach(message => {
                const userId = message.end_user_id.toString();
                if (!messagesByUser[userId]) {
                    messagesByUser[userId] = [];
                }
                messagesByUser[userId].push(message);
            });

            for (const userId of userIds) {
                const userMessages = messagesByUser[userId] || [];
                let unreadCount = 0;
                let lastMessageTime = new Date(0);
                const lastResponseTime = this.lastResponseTimes.get(userId);

                for (const message of userMessages) {
                    const messageTime = new Date(message.time);
                    if (messageTime > lastMessageTime) {
                        lastMessageTime = messageTime;
                    }

                    if (message.content && (!message.response || message.response.trim() === '')) {
                        if (!lastResponseTime || messageTime > lastResponseTime) {
                            unreadCount++;
                        }
                    }
                }

                if (userMessages.length === 0) {
                    lastMessageTime = new Date();
                }

                result[userId] = {
                    userId,
                    count: unreadCount,
                    lastMessageTime
                };

                this.unreadCounts.set(userId, unreadCount);
                this.lastMessageTimes.set(userId, lastMessageTime);
            }

            this.saveToCache();
            return result;
        } catch (error) {
            console.error('Error getting all unread counts:', error);
            
            for (const userId of userIds) {
                result[userId] = {
                    userId,
                    count: 0,
                    lastMessageTime: new Date()
                };
            }
            
            return result;
        }
    }

    private async updateUnreadCount(userId: string) {
        const count = await this.getUnreadCount(userId);
        const lastMessageTime = this.lastMessageTimes.get(userId) || new Date();
        
        this.subscriptions.forEach(callback => {
            callback(userId, count, lastMessageTime);
        });
    }

    // Позначення повідомлень як прочитаних при відправці відповіді
    async markMessagesAsReadAfterResponse(userId: string): Promise<void> {
        try {
            console.log(`Marking messages as read for user ${userId} after response`);
            
            // Встановлюємо час останньої відповіді
            this.lastResponseTimes.set(userId, new Date());
            this.unreadCounts.set(userId, 0);
            this.saveToCache();
            
            const lastMessageTime = this.lastMessageTimes.get(userId) || new Date();
            
            this.subscriptions.forEach(callback => {
                callback(userId, 0, lastMessageTime);
            });
        } catch (error) {
            console.error('Error in markMessagesAsReadAfterResponse:', error);
        }
    }

    // Позначення як прочитаних при відкритті чату
    async markAsRead(userId: string): Promise<void> {
        console.log(`Marking as read for user ${userId}`);
        this.unreadCounts.set(userId, 0);
        this.saveToCache();
        
        const lastMessageTime = this.lastMessageTimes.get(userId) || new Date();
        
        this.subscriptions.forEach(callback => {
            callback(userId, 0, lastMessageTime);
        });
    }

    // Отримання поточного лічильника з кешу
    getCachedUnreadCount(userId: string): number {
        return this.unreadCounts.get(userId) || 0;
    }

    // Отримання часу останнього повідомлення з кешу
    getCachedLastMessageTime(userId: string): Date | undefined {
        return this.lastMessageTimes.get(userId);
    }

    // Отримання часу останньої відповіді з кешу
    getCachedLastResponseTime(userId: string): Date | undefined {
        return this.lastResponseTimes.get(userId);
    }

    // Очищення кешу
    clearCache(): void {
        this.unreadCounts.clear();
        this.lastMessageTimes.clear();
        this.lastResponseTimes.clear();
        localStorage.removeItem(this.CACHE_KEY);
    }

    // Оновлення кешу для конкретного користувача
    async refreshUserCache(userId: string): Promise<void> {
        await this.getUnreadCount(userId);
    }

    // Примусове збереження кешу
    forceSaveCache(): void {
        this.saveToCache();
    }

    // Знищення сервісу
    destroy(): void {
        this.stopRealtimeSubscription();
        this.subscriptions.clear();
        this.saveToCache(); // Зберігаємо перед знищенням
        this.clearCache();
    }
}

export const messageService = new MessageService();
