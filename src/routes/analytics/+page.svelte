<script>
    import { onMount, onDestroy } from "svelte";
    import { supabase } from "$lib/supabaseClient";
    import { fetchAllRows } from "$lib/utils/fetchAll";
    import {
        getCurrentUser,
        getClientIdForFiltering,
    } from "../client-login/userUtils";

    // Define proper TypeScript interface using JSDoc
    /**
     * @typedef {Object} ActivityItem
     * @property {string} id
     * @property {string} type
     * @property {string} title
     * @property {Date} time
     * @property {string} chat_id
     */

    /**
     * @typedef {Object} AnalyticsData
     * @property {number} avgResponseTime
     * @property {number} completionRate
     * @property {number} totalChats
     * @property {number} uniqueUsers
     * @property {ActivityItem[]} recentActivity
     */

    /**
     * @typedef {Object} AuthUser
     * @property {number} id
     * @property {string} name
     * @property {string} [email]
     * @property {'alara_admin'|'user_admin'|'client_admin'} role
     * @property {'panel_admins'|'clients'|'client_users'} table
     * @property {number} [client_id]
     * @property {string} [created_at]
     */

    // Properly typed analytics variable
    /** @type {AnalyticsData} */
    let analytics = {
        avgResponseTime: 0,
        completionRate: 0,
        totalChats: 0,
        uniqueUsers: 0,
        recentActivity: [],
    };

    let isConnected = true;
    let lastUpdate = "--:--";

    /** @type {NodeJS.Timeout | null} */
    let updateInterval = null;

    /** @type {any} */
    let realtimeSubscription = null;

    // Get client_id from current user - properly typed
    /** @type {number | null} */
    let clientId = null;

    /** @type {AuthUser | null} */
    let currentUser = null;

    onMount(async () => {
        // Get current user and determine client_id
        currentUser = getCurrentUser();
        if (!currentUser) {
            console.error("No authenticated user found");
            isConnected = false;
            return;
        }

        // Determine client_id based on user role
        if (currentUser.role === "alara_admin") {
            // For super admin, we might want to show aggregated data or let them select a client
            // For now, let's show all data (we'll modify queries accordingly)
            clientId = null;
        } else {
            clientId = getClientIdForFiltering(currentUser);
        }

        console.log("Analytics initialized for client_id:", clientId);
        await loadAnalytics();
        startRealTimeUpdates();
        setupRealtimeSubscription();
    });

    onDestroy(() => {
        if (updateInterval) clearInterval(updateInterval);
        if (realtimeSubscription) realtimeSubscription.unsubscribe();
    });

    async function loadAnalytics() {
        try {
            const [responseTimeData, chatsData, usersData, activityData] =
                await Promise.all([
                    getAverageResponseTime(),
                    getTotalChats(),
                    getUniqueUsers(),
                    getRecentActivity(),
                ]);

            analytics = {
                avgResponseTime: responseTimeData || 0,
                completionRate: await getCompletionRate(),
                totalChats: chatsData || 0,
                uniqueUsers: usersData || 0,
                recentActivity: activityData || [],
            };

            updateLastUpdateTime();
            isConnected = true;
        } catch (error) {
            console.error("Error loading analytics:", error);
            isConnected = false;
        }
    }

    /**
     * @returns {Promise<number>}
     */
    async function getAverageResponseTime() {
        const data = await fetchAllRows((from, to) => {
            let query = supabase
                .from("messages")
                .select("time, response_time")
                .not("response_time", "is", null)
                .not("time", "is", null)
                .gte(
                    "time",
                    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                );

            // Apply client filter if not super admin
            if (clientId !== null) {
                query = query.eq("client_id", clientId);
            }

            return query.range(from, to);
        });

        if (!data || data.length === 0) return 0;

        const totalMinutes = data.reduce((sum, msg) => {
            const responseTime = new Date(msg.response_time);
            const messageTime = new Date(msg.time);
            const diffMinutes =
                (responseTime.getTime() - messageTime.getTime()) / (1000 * 60);
            return sum + diffMinutes;
        }, 0);

        return Math.round((totalMinutes / data.length) * 10) / 10;
    }

    /**
     * @returns {Promise<number>}
     */
    async function getCompletionRate() {
        // Get total unique chats
        const totalChats = await fetchAllRows((from, to) => {
            let totalQuery = supabase
                .from("messages")
                .select("chat_id")
                .not("chat_id", "is", null)
                .gte(
                    "time",
                    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                );

            if (clientId !== null) {
                totalQuery = totalQuery.eq("client_id", clientId);
            }

            return totalQuery.range(from, to);
        });

        const uniqueChats = [
            ...new Set(totalChats?.map((m) => m.chat_id) || []),
        ];

        if (uniqueChats.length === 0) return 0;

        // Get completed chats (chats with responses)
        const completedChats = await fetchAllRows((from, to) => {
            let completedQuery = supabase
                .from("messages")
                .select("chat_id")
                .not("response", "is", null)
                .not("chat_id", "is", null)
                .gte(
                    "time",
                    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                );

            if (clientId !== null) {
                completedQuery = completedQuery.eq("client_id", clientId);
            }

            return completedQuery.range(from, to);
        });

        const uniqueCompletedChats = [
            ...new Set(completedChats?.map((m) => m.chat_id) || []),
        ];

        return Math.round(
            (uniqueCompletedChats.length / uniqueChats.length) * 100,
        );
    }

    /**
     * @returns {Promise<number>}
     */
    async function getTotalChats() {
        const data = await fetchAllRows((from, to) => {
            let query = supabase
                .from("messages")
                .select("chat_id")
                .not("chat_id", "is", null)
                .gte(
                    "time",
                    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                );

            if (clientId !== null) {
                query = query.eq("client_id", clientId);
            }

            return query.range(from, to);
        });

        return [...new Set(data?.map((m) => m.chat_id) || [])].length;
    }

    /**
     * @returns {Promise<number>}
     */
    async function getUniqueUsers() {
        const data = await fetchAllRows((from, to) => {
            let query = supabase
                .from("messages")
                .select("end_user_id")
                .not("end_user_id", "is", null)
                .gte(
                    "time",
                    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                );

            if (clientId !== null) {
                query = query.eq("client_id", clientId);
            }

            return query.range(from, to);
        });

        return [...new Set(data?.map((m) => m.end_user_id) || [])].length;
    }

    /**
     * @returns {Promise<ActivityItem[]>}
     */
    async function getRecentActivity() {
        let query = supabase
            .from("messages")
            .select("*")
            .order("time", { ascending: false })
            .limit(10);

        if (clientId !== null) {
            query = query.eq("client_id", clientId);
        }

        const { data, error } = await query;
        if (error) throw error;

        return (
            data?.map((msg) => ({
                id: msg.id,
                type: msg.response ? "response" : "message",
                title: msg.response ? "Bot responded" : "New message received",
                time: new Date(msg.time),
                chat_id: msg.chat_id,
            })) || []
        );
    }

    function setupRealtimeSubscription() {
        let channel = supabase.channel("messages_changes");

        // Setup realtime subscription
        let subscription = channel.on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: "messages",
                // If we have a specific client, filter by it
                ...(clientId !== null && {
                    filter: `client_id=eq.${clientId}`,
                }),
            },
            (/** @type {any} */ payload) => {
                console.log("Real-time update:", payload);
                handleRealtimeUpdate(payload);
            },
        );

        realtimeSubscription = subscription.subscribe();
    }

    /**
     * @param {any} payload
     */
    function handleRealtimeUpdate(payload) {
        // Only process if it's for our client (additional check)
        if (clientId !== null && payload.new?.client_id !== clientId) {
            return;
        }

        // Add new activity
        if (payload.eventType === "INSERT") {
            const newActivity = {
                id: payload.new.id,
                type: payload.new.response ? "response" : "message",
                title: payload.new.response
                    ? "Bot responded"
                    : "New message received",
                time: new Date(payload.new.time),
                chat_id: payload.new.chat_id,
            };

            analytics.recentActivity = [
                newActivity,
                ...analytics.recentActivity.slice(0, 9),
            ];
        }

        // Update analytics after 2 seconds
        setTimeout(() => {
            loadAnalytics();
        }, 2000);
    }

    function startRealTimeUpdates() {
        // Update every 30 seconds
        updateInterval = setInterval(() => {
            loadAnalytics();
        }, 30000);
    }

    function updateLastUpdateTime() {
        const now = new Date();
        lastUpdate = now.toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    /**
     * @param {Date} date
     * @returns {string}
     */
    function formatTimeAgo(date) {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        if (diff < 60000) return "Just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    }

    /**
     * @param {string} type
     * @returns {string}
     */
    function getActivityIcon(type) {
        return type === "response" ? "✅" : "💬";
    }

    /**
     * @param {string} type
     * @returns {string}
     */
    function getActivityClass(type) {
        return type === "response" ? "response" : "message";
    }
</script>

<div class="analyt-container">
    <div class="header-section">
        <h1>Your Analytics</h1>
        <div class="status-indicator">
            <div class="connection-status" class:disconnected={!isConnected}>
                <div class="status-dot" class:disconnected={!isConnected}></div>
                <span>{isConnected ? "Live" : "Offline"}</span>
            </div>
        </div>
        <div class="chat-list">
            <p>Updated at {lastUpdate}</p>
            {#if currentUser}
                <small>
                    Viewing data for: {currentUser.name}
                    {#if currentUser.role === "alara_admin"}
                        (All Clients)
                    {:else}
                        (Client ID: {clientId})
                    {/if}
                </small>
            {/if}
        </div>
    </div>

    <div class="analyt-data">
        <div class="block" data-metric="response-time">
            <div class="img-bg-1">
                <div class="metric-content">
                    <h2 class="counter">{analytics.avgResponseTime}</h2>
                    <span class="unit">min</span>
                </div>
                <div class="metric-trend neutral">
                    <span class="trend-icon neutral">→</span>
                    <span class="trend-text">--</span>
                </div>
                <div class="pulse-indicator"></div>
            </div>
            <div class="text-bm">
                <p>Average response time</p>
                <small class="metric-subtitle">Last 24 hours</small>
            </div>
        </div>

        <div class="block" data-metric="completion">
            <div class="img-bg-2">
                <div class="metric-content">
                    <h2 class="counter">{analytics.completionRate}</h2>
                    <span class="unit">%</span>
                </div>
                <div class="metric-trend neutral">
                    <span class="trend-icon neutral">→</span>
                    <span class="trend-text">--</span>
                </div>
                <div class="pulse-indicator"></div>
            </div>
            <div class="text-bm">
                <p>Completion rate</p>
                <small class="metric-subtitle">Resolved conversations</small>
            </div>
        </div>

        <div class="block" data-metric="total-chats">
            <div class="img-bg-3">
                <div class="metric-content">
                    <h2 class="counter">{analytics.totalChats}</h2>
                    <span class="unit">chats</span>
                </div>
                <div class="metric-trend neutral">
                    <span class="trend-icon neutral">→</span>
                    <span class="trend-text">--</span>
                </div>
                <div class="pulse-indicator"></div>
            </div>
            <div class="text-bm">
                <p>Active conversations</p>
                <small class="metric-subtitle">Today</small>
            </div>
        </div>

        <div class="block" data-metric="unique-users">
            <div class="img-bg-4">
                <div class="metric-content">
                    <h2 class="counter">{analytics.uniqueUsers}</h2>
                    <span class="unit">users</span>
                </div>
                <div class="metric-trend neutral">
                    <span class="trend-icon neutral">→</span>
                    <span class="trend-text">--</span>
                </div>
                <div class="pulse-indicator"></div>
            </div>
            <div class="text-bm">
                <p>Unique users</p>
                <small class="metric-subtitle">Active today</small>
            </div>
        </div>
    </div>

    <div class="real-time-section">
        <div class="activity-chart">
            <h3>Recent Activity</h3>
            <div class="simple-stats">
                <div class="stat-item">
                    <span class="stat-label">Last Hour:</span>
                    <span class="stat-value">
                        {analytics.recentActivity.filter(
                            (/** @type {ActivityItem} */ a) =>
                                new Date().getTime() - a.time.getTime() <
                                3600000,
                        ).length}
                    </span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Last 5 Minutes:</span>
                    <span class="stat-value">
                        {analytics.recentActivity.filter(
                            (/** @type {ActivityItem} */ a) =>
                                new Date().getTime() - a.time.getTime() <
                                300000,
                        ).length}
                    </span>
                </div>
            </div>
        </div>

        <div class="live-feed">
            <h3>Live Activity Feed</h3>
            <div class="activity-feed">
                {#each analytics.recentActivity as activity (activity.id)}
                    <div class="activity-item">
                        <div
                            class="activity-icon {getActivityClass(
                                activity.type,
                            )}"
                        >
                            {getActivityIcon(activity.type)}
                        </div>
                        <div class="activity-content">
                            <div class="activity-title">{activity.title}</div>
                            <div class="activity-meta">
                                <span class="activity-time">
                                    {formatTimeAgo(activity.time)}
                                </span>
                                {#if activity.chat_id}
                                    <span class="activity-chat">
                                        Chat: {activity.chat_id.slice(0, 8)}...
                                    </span>
                                {/if}
                            </div>
                        </div>
                    </div>
                {/each}
                {#if analytics.recentActivity.length === 0}
                    <div class="no-activity">
                        <p>No recent activity</p>
                        <small
                            >Messages will appear here when users interact with
                            your bot</small
                        >
                    </div>
                {/if}
            </div>
        </div>
    </div>
</div>

<style>
    /* Ваші існуючі стилі + додаткові */
    .analyt-container {
        color: var(--color-fff);
        padding: 2rem 3rem;
        background: linear-gradient(
            135deg,
            var(--color-070709) 0%,
            #0a0a0c 100%
        );
        animation: fadeIn 0.8s ease-out;
    }

    .connection-status.disconnected {
        background: rgba(239, 68, 68, 0.1);
        border-color: rgba(239, 68, 68, 0.2);
    }

    .simple-stats {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        margin-top: 1rem;
    }

    .stat-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
    }

    .stat-label {
        color: var(--color-9b9ca3);
        font-size: 0.875rem;
    }

    .stat-value {
        color: #22c55e;
        font-weight: 600;
        font-size: 1.25rem;
    }

    .no-activity {
        text-align: center;
        padding: 2rem;
        color: var(--color-9b9ca3);
    }

    .no-activity p {
        margin: 0;
        font-style: italic;
    }

    /* Анімації для оновлення даних */
    .counter {
        transition: all 0.3s ease;
    }

    .chat-list p {
        color: var(--color-9b9ca3);
    }

    @keyframes pulseGlow {
        0% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
        }
        70% {
            transform: scale(1.2);
            box-shadow: 0 0 0 10px rgba(34, 197, 94, 0);
        }
        100% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
        }
    }

    /* Анімація для нових елементів активності */
    .activity-item {
        animation: slideInRight 0.3s ease-out;
    }

    @keyframes slideInRight {
        from {
            transform: translateX(20px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }

    /* Ваші існуючі стилі */
    .header-section {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 3rem;
        animation: slideInFromTop 0.6s ease-out;
    }

    .status-indicator {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.5rem;
    }

    .connection-status {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        background: rgba(34, 197, 94, 0.1);
        border-radius: 20px;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(34, 197, 94, 0.2);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22c55e;
        animation: pulse 2s infinite;
    }

    .status-dot.disconnected {
        background: #ef4444;
        animation: none;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }

    .last-update {
        font-size: 0.75rem;
        color: var(--color-9b9ca3);
    }

    .analyt-data {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 2rem;
        margin-bottom: 3rem;
    }

    .block {
        border-radius: 24px;
        background: linear-gradient(145deg, var(--color-121214), #1a1a1c);
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        overflow: hidden;
        opacity: 0;
        transform: translateY(40px);
        animation: slideInUp 0.6s ease-out forwards;
        animation-delay: calc(var(--delay, 0) * 0.1s);
        cursor: pointer;
        padding: 1.5rem;
    }

    @keyframes slideInUp {
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @keyframes fadeIn {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    @keyframes slideInFromTop {
        from {
            transform: translateY(-20px);
            opacity: 0;
        }
        to {
            transform: translateY(0);
            opacity: 1;
        }
    }

    .pulse-indicator {
        position: absolute;
        top: 1rem;
        right: 1rem;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: transparent;
        transition: all 0.3s ease;
    }

    .metric-content {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        margin-bottom: 1rem;
        position: relative;
    }

    .counter {
        font-size: clamp(28px, 5vw, 48px);
        font-weight: 700;
        color: #fff;
        margin: 0;
        text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    }

    .unit {
        font-size: 1rem;
        color: var(--color-9b9ca3);
        font-weight: 400;
    }

    .metric-trend {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.25rem 0.75rem;
        border-radius: 20px;
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
        font-size: 0.75rem;
    }

    .metric-trend.positive {
        background: rgba(34, 197, 94, 0.2);
        border: 1px solid rgba(34, 197, 94, 0.3);
    }

    .metric-trend.negative {
        background: rgba(239, 68, 68, 0.2);
        border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .metric-trend.neutral {
        background: rgba(156, 163, 175, 0.2);
        border: 1px solid rgba(156, 163, 175, 0.3);
    }

    .trend-icon {
        font-size: 1rem;
        transition: transform 0.3s ease;
    }

    .trend-icon.up {
        color: #22c55e;
        transform: rotate(-45deg);
    }

    .trend-icon.down {
        color: #ef4444;
        transform: rotate(45deg);
    }

    .trend-icon.neutral {
        color: #9ca3af;
    }

    .text-bm {
        margin-top: 1rem;
    }

    .text-bm p {
        margin: 0;
        font-weight: 600;
        color: var(--color-fff);
    }

    .metric-subtitle {
        font-size: 0.75rem;
        color: var(--color-9b9ca3);
        margin-top: 0.25rem;
        display: block;
    }

    .real-time-section {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: 2rem;
        margin-top: 2rem;
    }

    .activity-chart,
    .live-feed {
        background: linear-gradient(145deg, var(--color-121214), #1a1a1c);
        border-radius: 24px;
        padding: 2rem;
        animation: slideInUp 0.6s ease-out 0.5s both;
    }

    .activity-chart h3,
    .live-feed h3 {
        margin: 0 0 1.5rem 0;
        color: var(--color-fff);
        font-size: 1.25rem;
    }

    .live-feed {
        max-height: 400px;
        overflow-y: auto;

        /* Сховати скролбар для WebKit-браузерів (Chrome, Safari) */
        scrollbar-width: none; /* Firefox */
        -ms-overflow-style: none; /* IE 10+ */
    }

    .live-feed::-webkit-scrollbar {
        display: none; /* Chrome, Safari */
    }

    .activity-feed {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .activity-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        border-left: 3px solid #22c55e;
        transition: all 0.3s ease;
    }

    .activity-item:hover {
        background: rgba(255, 255, 255, 0.1);
        transform: translateX(4px);
    }

    .activity-icon {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.875rem;
        flex-shrink: 0;
    }

    .activity-icon.message {
        background: rgba(59, 130, 246, 0.2);
        color: #3b82f6;
    }

    .activity-icon.response {
        background: rgba(34, 197, 94, 0.2);
        color: #22c55e;
    }

    .activity-content {
        flex: 1;
    }

    .activity-title {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-fff);
        margin: 0 0 0.25rem 0;
    }

    .activity-time {
        font-size: 0.75rem;
        color: var(--color-9b9ca3);
    }

    /* Scrollbar styling */
    .live-feed::-webkit-scrollbar {
        width: 6px;
    }

    .live-feed::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
    }

    .live-feed::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 3px;
    }

    .live-feed::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
    }

    /* Responsive Design */
    @media (max-width: 1200px) {
        .real-time-section {
            grid-template-columns: 1fr;
        }

        .header-section {
            flex-direction: column;
            gap: 1rem;
        }

        .status-indicator {
            align-items: flex-start;
        }
    }

    @media (max-width: 768px) {
        .analyt-container {
            padding: 1.5rem;
        }

        .analyt-data {
            grid-template-columns: 1fr;
            gap: 1rem;
        }

        .activity-chart,
        .live-feed {
            padding: 1.5rem;
        }
    }
</style>
