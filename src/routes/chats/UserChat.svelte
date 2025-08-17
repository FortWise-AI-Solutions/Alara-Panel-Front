<script lang="ts">
  import type { User } from "../../lib/types/type";
  import hisIcon from "../../lib/images/history.png";
  import alara from "../../lib/images/alara.png";
  import admin from "../../lib/images/admin.jpg";
  import { themeStore } from "../../lib/store/theme";
  import { supabase } from "../../lib/supabaseClient";
  import { onMount, onDestroy } from "svelte";
  import { PUBLIC_WEB_SERVER } from "$env/static/public";
  import {
    getCachedLocalTime,
    clearUserTimestampCache,
    getTimestampCacheStats,
    debugTimezone,
    getUserTimezone,
  } from "./timezone/timezone";

  export let selectedUser: User;
  export let onBackToList: () => void = () => {};
  export let onToggleFullscreen: () => void = () => {};
  export let isFullscreen: boolean = false;
  export let backgroundImage: string | null = null;
  export let currentClientId: number = 1;

  interface DatabaseMessage {
    id: number;
    client_id: number;
    bot_id: number | null;
    end_user_id: number | null;
    content: string | null;
    platform: string | null;
    time: string | null;
    raw_payload: any;
    response: string | null;
    is_written_by_alara: boolean | null;
  }

  interface Message {
    id: string;
    text: string;
    sender: "user" | "bot" | "admin";
    timestamp: string;
    date: string;
    originalId: number;
    isNew?: boolean;
    isWrittenByAlara?: boolean;
    dbTimestamp: Date; // Додаємо оригінальний час з БД для сортування
  }

  // Додаємо змінну для відстеження часу завантаження компонента, закоментував
  //  let componentLoadTime: Date;

  let rerenderTrigger: number = 0;
  let rerenderInterval: NodeJS.Timeout | null = null;

  let showTransferModal: boolean = false;
  let showAlaraToggleModal: boolean = false;
  let pendingAlaraAction: "enable" | "disable" | null = null;

  let statusUpdateInterval: NodeJS.Timeout | null = null;

  // Додайте цю функцію для запуску ререндерингу
  function startRerenderInterval(): void {
    if (rerenderInterval) {
      clearInterval(rerenderInterval);
    }
    rerenderInterval = setInterval(() => {
      rerenderTrigger = Date.now();
    }, 1000);
  }

  // Додайте цю функцію для зупинки ререндерингу
  function stopRerenderInterval(): void {
    if (rerenderInterval) {
      clearInterval(rerenderInterval);
      rerenderInterval = null;
    }
  }

  // Оновіті статуси та їх кольори
  const statusConfig: Record<string, { color: string; label: string }> = {
    online: { color: "#4DE944", label: "Online" },
    offline: { color: "#E94447", label: "Offline" },
    "human-required": { color: "#E9D644", label: "Human Required" },
    "no-info": { color: "#6b7280", label: "No Info" },
  };

  // Функція для розрахунку локального часу повідомлення
  function calculateLocalMessageTime(
    dbTimestamp: Date,
    isNewMessage: boolean = false,
  ): { timeString: string; dateString: string } {
    let displayTime: Date;
    if (isNewMessage) {
      // Для нових повідомлень використовуємо поточний час
      displayTime = new Date();
    } else {
      // Для існуючих повідомлень просто використовуємо час з БД як є
      displayTime = new Date(dbTimestamp);
    }

    const timeString = displayTime.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const dateString = displayTime.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    return { timeString, dateString };
  }

  let userHumanRequired: boolean = false;

  let transferringToAI: boolean = false;
  let transferError: string | null = null;
  $: isHumanRequired = userHumanRequired;

  async function fetchUserStatus(): Promise<void> {
    if (!selectedUser?.id) return;

    try {
      const { data, error } = await supabase
        .from("end_users")
        .select("username, human_required, alara_status") // Додаємо alara_status
        .eq("id", parseInt(selectedUser.id))
        .single();

      if (error) {
        console.error("Error fetching user status:", error);
        return;
      }
      //TODO: fix this as fast as possible later
      if (data?.username) {
        selectedUser = {
          ...selectedUser,
          username: data.username,
        };
      }

      if (data) {
        const oldHumanRequired = userHumanRequired;
        const oldStatus = selectedUser.status;

        userHumanRequired = data.human_required || false;

        // Визначаємо новий статус на основі полів з БД (як у UserList)
        let newStatus = "no-info";
        if (data.human_required === true) {
          newStatus = "human-required";
        } else if (data.alara_status === true) {
          newStatus = "online";
        } else if (data.alara_status === false) {
          newStatus = "offline";
        }

        // Оновлюємо selectedUser якщо статус змінився
        if (newStatus !== oldStatus) {
          selectedUser = {
            ...selectedUser,
            status: newStatus,
            alara_status: data.alara_status,
            human_required: data.human_required,
          };
          console.log(
            `User ${selectedUser.id} status updated from ${oldStatus} to ${newStatus}`,
          );
        }

        // Оновлюємо currentAlaraStatus для кнопки
        currentAlaraStatus = data.alara_status ?? true;

        console.log(`User ${selectedUser.id} status check:`, {
          human_required: userHumanRequired,
          alara_status: data.alara_status,
          calculated_status: newStatus,
          status_changed: oldStatus !== newStatus,
        });
      }
    } catch (err) {
      console.error("Error fetching user status:", err);
    }
  }

  // Функція для запуску інтервалу оновлення статусу
  function startStatusUpdateInterval(): void {
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
    }
    statusUpdateInterval = setInterval(() => {
      fetchUserStatus();
    }, 1000); // Кожну секунду, як у UserList
  }

  // Функція для зупинки інтервалу оновлення статусу
  function stopStatusUpdateInterval(): void {
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
  }

  function initiateTransferToAI(): void {
    if (!selectedUser?.id || transferringToAI || !isHumanRequired) return;
    showTransferModal = true;
  }

  async function confirmTransferToAI(): Promise<void> {
    showTransferModal = false;

    if (!selectedUser?.id || transferringToAI || !isHumanRequired) return;

    transferringToAI = true;
    transferError = null;

    try {
      console.log("Transferring user to AI:", selectedUser.id);
      const response = await fetch(
        `${PUBLIC_WEB_SERVER}/api/operator/transfer-to-ai`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({
            userId: parseInt(selectedUser.id),
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const result = await response.json();
      console.log("Transfer to AI response:", result);

      if (result.success) {
        console.log("✅ User transferred to AI successfully");
        userHumanRequired = false;
      }
    } catch (err) {
      console.error("Error transferring to AI:", err);
      transferError =
        err instanceof Error ? err.message : "Failed to transfer to AI";
    } finally {
      transferringToAI = false;
    }
  }

  function cancelTransferToAI(): void {
    showTransferModal = false;
  }

  let togglingAlara: boolean = false;
  let alaraError: string | null = null;
  let currentAlaraStatus: boolean = true;

  function initiateAlaraToggle(): void {
    if (!selectedUser?.id || togglingAlara) return;
    pendingAlaraAction = currentAlaraStatus ? "disable" : "enable";
    showAlaraToggleModal = true;
  }

  async function confirmAlaraToggle(): Promise<void> {
    showAlaraToggleModal = false;

    if (!selectedUser?.id || togglingAlara || !pendingAlaraAction) return;

    const newStatus = pendingAlaraAction === "enable";
    togglingAlara = true;
    alaraError = null;

    try {
      const requestData = {
        userId: parseInt(selectedUser.id),
        alaraStatus: newStatus,
      };

      console.log("🔍 Sending request data:", requestData);

      const response = await fetch(
        `${PUBLIC_WEB_SERVER}/api/operator/toggle-alara-status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify(requestData),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      if (result.success) {
        currentAlaraStatus = newStatus;
        console.log(
          `✅ Alara ${newStatus ? "enabled" : "disabled"} successfully`,
        );
      } else {
        throw new Error(result.error || "Unknown error occurred");
      }
    } catch (err) {
      console.error("🔴 Error toggling Alara status:", err);
      alaraError =
        err instanceof Error ? err.message : "Failed to toggle Alara status";
    } finally {
      togglingAlara = false;
      pendingAlaraAction = null;
    }
  }

  function cancelAlaraToggle(): void {
    showAlaraToggleModal = false;
    pendingAlaraAction = null;
  }

  // Функція для обробки клавіатури для модальних вікон
  function handleTransferModalKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      cancelTransferToAI();
    }
  }

  function handleAlaraModalKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      cancelAlaraToggle();
    }
  }

  // Оновлена функція loadAlaraStatus з fallback на API
  async function loadAlaraStatus(): Promise<void> {
    if (!selectedUser?.id) return;

    try {
      // Спочатку пробуємо через Supabase
      const { data, error } = await supabase
        .from("end_users")
        .select("alara_status")
        .eq("id", parseInt(selectedUser.id))
        .single();

      if (error) {
        // Якщо Supabase не працює, пробуємо через API
        const response = await fetch(
          `${PUBLIC_WEB_SERVER}/api/operator/alara-status/${selectedUser.id}`,
          {
            headers: {
              "ngrok-skip-browser-warning": "true",
            },
          },
        );

        if (response.ok) {
          const result = await response.json();
          currentAlaraStatus = result.alaraStatus ?? true;
        } else {
          throw error;
        }
      } else {
        currentAlaraStatus = data?.alara_status ?? true;
      }

      console.log(
        `Current Alara status for user ${selectedUser.id}:`,
        currentAlaraStatus,
      );
    } catch (err) {
      console.error("Error loading Alara status:", err);
      currentAlaraStatus = true; // За замовчуванням
    }
  }

  // Генерація градієнта для аватара
  function generateGradient(): string {
    const colors = [
      "#fbbf24",
      "#4DE944",
      "#8b5cf6",
      "#ec4899",
      "#3b82f6",
      "#2097F0",
      "#D0523B",
      "#9B84BA",
      "#C48C55",
      "#B13EB0",
      "#81589E",
      "#DAEBF9",
      "#D042C2",
      "#B85124",
      "#1F3C27",
      "#E1B310",
      "#2CF2A1",
      "#FFFFFF",
    ];
    const color1 = colors[Math.floor(Math.random() * colors.length)];
    let color2 = colors[Math.floor(Math.random() * colors.length)];
    while (color2 === color1) {
      color2 = colors[Math.floor(Math.random() * colors.length)];
    }
    const angle = Math.floor(Math.random() * 360);
    return `linear-gradient(${angle}deg, ${color1}, ${color2})`;
  }

  // Кешування градієнтів для кожного користувача
  const gradientCache = new Map<string, string>();
  function getUserGradient(userId: string): string {
    if (!gradientCache.has(userId)) {
      gradientCache.set(userId, generateGradient());
    }
    return gradientCache.get(userId)!;
  }

  function getStatusInfo(status: string): { color: string; label: string } {
    return statusConfig[status] || statusConfig["no-info"];
  }

  // Додати цю реактивну змінну після існуючих реактивних змінних
  $: statusInfo = getStatusInfo(selectedUser.status || "no-info");

  // Стан повідомлень та завантаження
  let messages: Message[] = [];
  let loading: boolean = false;
  let error: string | null = null;
  let newMessage: string = "";
  let messagesContainer: HTMLElement;
  let currentUserId: string = "";
  let updateInterval: NodeJS.Timeout | null = null;
  let lastMessageCount: number = 0;
  let isAtBottom: boolean = true;

  // Стан для історії та Алари
  let showHistory: boolean = false;
  let isAlaraEnabled: boolean = true;
  let showConfirmModal: boolean = false;
  let confirmAction: "enable" | "disable" | null = null;

  // Змінні для роботи з повідомленнями
  let sendingMessage: boolean = false;
  let sendError: string | null = null;

  // Функція для завантаження повідомлень з бази даних
  async function loadMessages(silent: boolean = false): Promise<void> {
    if (!selectedUser?.id) return;
    if (!silent) {
      loading = true;
    }
    error = null;

    try {
      const { data, error: fetchError } = await supabase
        .from("messages")
        .select("*")
        .eq("end_user_id", parseInt(selectedUser.id))
        .order("time", { ascending: true });

      if (fetchError) {
        throw fetchError;
      }

      const newMessages = convertDatabaseMessagesToDisplayMessages(
        data || [],
        silent, // передаємо інформацію про те, чи це оновлення
      );

      // Перевіряємо чи є нові повідомлення
      const hasNewMessages = newMessages.length > lastMessageCount;
      lastMessageCount = newMessages.length;

      // Оновлюємо повідомлення тільки якщо є зміни
      if (
        JSON.stringify(messages.map((m) => m.id)) !==
        JSON.stringify(newMessages.map((m) => m.id))
      ) {
        messages = newMessages;
        // Прокручуємо до низу тільки якщо користувач був внизу або є нові повідомлення
        if (isAtBottom || hasNewMessages) {
          setTimeout(() => {
            scrollToBottom();
          }, 50);
        }
      }
    } catch (err) {
      console.error("Error loading messages:", err);
      if (!silent) {
        error = err instanceof Error ? err.message : "Failed to load messages";
      }
    } finally {
      if (!silent) {
        loading = false;
      }
    }
  }

  // Updated function using proper timezone conversion
  function convertDatabaseMessagesToDisplayMessages(
    dbMessages: DatabaseMessage[],
    isUpdate: boolean = false,
  ): Message[] {
    const convertedMessages: Message[] = [];
    const existingMessageIds = new Set(messages.map((m) => m.id));
    // Track processed message IDs to prevent duplicates
    const processedIds = new Set();
    // Track which messages have been processed by their original ID
    const processedOriginalIds = new Set();

    console.log(
      `🕐 Converting ${dbMessages.length} messages for timezone: ${getUserTimezone()}`,
    );

    // First, deduplicate messages by their ID
    const uniqueMessages = dbMessages.filter(
      (msg, index, self) => index === self.findIndex((m) => m.id === msg.id),
    );

    uniqueMessages.forEach((dbMsg) => {
      // Skip if we've already processed a message with this ID
      if (processedOriginalIds.has(dbMsg.id)) {
        console.log(`Skipping duplicate message with ID: ${dbMsg.id}`);
        return;
      }

      // Mark this message ID as processed
      processedOriginalIds.add(dbMsg.id);

      // Get timestamp from database (should be in UTC)
      const dbTimestamp = dbMsg.time ? dbMsg.time : new Date().toISOString();

      // Debug first message
      if (
        process.env.NODE_ENV === "development" &&
        uniqueMessages.indexOf(dbMsg) === 0
      ) {
        debugTimezone(dbTimestamp);
      }

      // Add user message
      if (dbMsg.content) {
        const userMessageId = `${selectedUser.id}-${dbMsg.id}-user`;

        // Skip if we've already processed this message
        if (!processedIds.has(userMessageId)) {
          processedIds.add(userMessageId);

          const isNewMessage =
            isUpdate && !existingMessageIds.has(userMessageId);

          // Use global cache for timezone-aware timestamp conversion
          const { timeString, dateString, localTimestamp } = getCachedLocalTime(
            dbTimestamp,
            userMessageId,
            isNewMessage,
          );

          convertedMessages.push({
            id: userMessageId,
            text: dbMsg.content,
            sender: "user",
            timestamp: timeString,
            date: dateString,
            originalId: dbMsg.id,
            dbTimestamp: localTimestamp,
            isNew: isNewMessage,
          });
        }
      }

      // Add response (bot or admin)
      if (dbMsg.response) {
        const isFromAlara = dbMsg.is_written_by_alara !== false;
        const responseMessageId = `${selectedUser.id}-${dbMsg.id}-${isFromAlara ? "bot" : "admin"}`;

        // Skip if we've already processed this message
        if (!processedIds.has(responseMessageId)) {
          processedIds.add(responseMessageId);

          const isNewMessage =
            isUpdate && !existingMessageIds.has(responseMessageId);

          // Use global cache for timezone-aware timestamp conversion
          const { timeString, dateString, localTimestamp } = getCachedLocalTime(
            dbTimestamp,
            responseMessageId,
            isNewMessage,
          );

          convertedMessages.push({
            id: responseMessageId,
            text: dbMsg.response,
            sender: isFromAlara ? "bot" : "admin",
            timestamp: timeString,
            date: dateString,
            originalId: dbMsg.id,
            isWrittenByAlara: isFromAlara,
            dbTimestamp: localTimestamp,
            isNew: isNewMessage,
          });
        }
      }
    });

    // Sort by local timestamp
    const sorted = convertedMessages.sort(
      (a, b) => a.dbTimestamp.getTime() - b.dbTimestamp.getTime(),
    );

    console.log(`🕐 Converted and sorted ${sorted.length} messages`);
    return sorted;
  }

  // Show timezone info on component mount (for debugging)
  onMount(() => {
    if (process.env.NODE_ENV === "development") {
      console.log("🕐 UserChat mounted with timezone:", {
        timezone: getUserTimezone(),
        offset: -new Date().getTimezoneOffset(),
        sample: new Date().toLocaleString(),
      });
    }
  });

  // Функція для перевірки чи користувач внизу чату
  function checkIfAtBottom(): void {
    if (messagesContainer) {
      const threshold = 100; // пікселів від низу
      isAtBottom =
        messagesContainer.scrollHeight -
          messagesContainer.scrollTop -
          messagesContainer.clientHeight <
        threshold;
    }
  }

  // Функція для прокрутки до низу
  function scrollToBottom(): void {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      isAtBottom = true;
    }
  }

  // Add debouncing to prevent excessive updates
  let updateTimeout: NodeJS.Timeout | null = null;
  function debouncedLoadMessages(silent: boolean = false) {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(() => {
      loadMessages(silent);
    }, 100);
  }

  // Замініть існуючу функцію sendMessage на цю:
  async function sendMessage(): Promise<void> {
    if (newMessage.trim() === "" || !selectedUser?.id || sendingMessage) return;

    const messageText = newMessage.trim();
    newMessage = "";
    sendingMessage = true;
    sendError = null;

    try {
      console.log("Sending message:", {
        userId: selectedUser.id,
        message: messageText,
        platform: selectedUser.platform,
      });

      const response = await fetch(
        `${PUBLIC_WEB_SERVER}/api/operator/send-message`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({
            userId: parseInt(selectedUser.id),
            message: messageText,
            platform: selectedUser.platform,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const result = await response.json();
      console.log("Server response:", result);

      if (result.success) {
        console.log("Message sent successfully:", result);

        // Якщо є delivery_status, перевіряємо його
        if (result.delivery_status) {
          if (
            result.delivery_status === "delivered" ||
            result.delivery_status === "sent" ||
            result.delivery_status === "success"
          ) {
            console.log("✅ Message delivered to user");
          } else {
            console.warn(
              "⚠️ Unexpected delivery status:",
              result.delivery_status,
            );
            sendError = `Unexpected delivery status: ${result.delivery_status}`;
          }
        } else {
          // Якщо немає delivery_status, вважаємо що все ОК
          console.log("✅ Message processed successfully");
        }
      }

      setTimeout(() => {
        loadMessages(true);
      }, 500);
    } catch (err) {
      console.error("Error sending message:", err);
      sendError = err instanceof Error ? err.message : "Failed to send message";
      newMessage = messageText;
    } finally {
      sendingMessage = false;
    }
  }

  // Обробка натискання Enter
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  // Оновлена функція startAutoUpdate
  function startAutoUpdate(): void {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    updateInterval = setInterval(() => {
      if (selectedUser?.id) {
        loadMessages(true);
        // Видаляємо fetchUserStatus() звідси, оскільки тепер є окремий інтервал
      }
    }, 1000);

    // Запускаємо окремий інтервал для статусу
    startStatusUpdateInterval();
  }

  // Оновлена функція stopAutoUpdate
  function stopAutoUpdate(): void {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    stopStatusUpdateInterval();
  }

  // Функції для роботи з історією
  function toggleHistory(): void {
    showHistory = !showHistory;
  }

  // Функція для отримання повідомлень користувача
  function getUserMessages(): Message[] {
    return messages
      .filter((msg) => msg.sender === "user")
      .sort((a, b) => {
        // Сортуємо по dbTimestamp для правильного порядку
        const timeA = a.dbTimestamp ? new Date(a.dbTimestamp).getTime() : 0;
        const timeB = b.dbTimestamp ? new Date(b.dbTimestamp).getTime() : 0;
        return timeA - timeB;
      });
  }

  // Функція для групування повідомлень користувача по датах
  function groupUserMessagesByDate(
    userMessages: Message[],
  ): Array<{ date: string; messages: Message[] }> {
    const grouped = userMessages.reduce(
      (acc: Record<string, Message[]>, message) => {
        if (!acc[message.date]) {
          acc[message.date] = [];
        }
        acc[message.date].push(message);
        return acc;
      },
      {},
    );

    return Object.entries(grouped).map(([date, msgs]) => ({
      date,
      messages: msgs,
    }));
  }

  // Функція для групування повідомлень по датах
  function groupMessagesByDate(
    messages: Message[],
  ): Array<{ date: string; messages: Message[] }> {
    const grouped = messages.reduce(
      (acc: Record<string, Message[]>, message) => {
        if (!acc[message.date]) {
          acc[message.date] = [];
        }
        acc[message.date].push(message);
        return acc;
      },
      {},
    );

    return Object.entries(grouped).map(([date, msgs]) => ({
      date,
      messages: msgs,
    }));
  }

  // Функції для керування Аларою
  function handleAlaraToggle(): void {
    confirmAction = isAlaraEnabled ? "disable" : "enable";
    showConfirmModal = true;
  }

  function confirmAlaraAction(): void {
    if (confirmAction === "disable") {
      isAlaraEnabled = false;
    } else if (confirmAction === "enable") {
      isAlaraEnabled = true;
    }
    showConfirmModal = false;
    confirmAction = null;
  }

  function cancelAlaraAction(): void {
    showConfirmModal = false;
    confirmAction = null;
  }

  // Обробка клавіатури для модального вікна
  function handleModalKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      cancelAlaraAction();
    }
  }

  // Реактивні змінні
  $: userMessages = getUserMessages();
  $: groupedMessages = groupMessagesByDate(userMessages);
  $: groupedAllMessages = groupMessagesByDate(messages);

  // Функція для отримання стилю фону
  function getChatBackgroundStyle(): string {
    if (backgroundImage) {
      return `
                background-image: url(${backgroundImage});
                background-position: center center;
                background-size: cover;
                background-repeat: no-repeat;
                background-attachment: local;
            `;
    }
    return $themeStore === "dark"
      ? "background-color: #1a1a1a;"
      : "background-color: #f5f5f5;";
  }

  onMount(() => {
    console.log("UserChat mounted for user:", selectedUser.id);
    currentUserId = selectedUser.id;
    fetchUserStatus();
    loadAlaraStatus(); // Якщо потрібно
    loadMessages();
    startAutoUpdate(); // Тепер включає і статус, і повідомлення
    startRerenderInterval();

    if (messagesContainer) {
      messagesContainer.addEventListener("scroll", checkIfAtBottom);
    }
  });

  onDestroy(() => {
    console.log("UserChat destroyed");
    stopAutoUpdate(); // Зупиняє і повідомлення, і статус
    stopRerenderInterval();
    if (messagesContainer) {
      messagesContainer.removeEventListener("scroll", checkIfAtBottom);
    }
  });

  // Оновлений реактивний блок для зміни користувача
  $: if (selectedUser?.id && selectedUser.id !== currentUserId) {
    console.log(`User changed from ${currentUserId} to ${selectedUser.id}`);
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(() => {
      currentUserId = selectedUser.id;
      messages = [];
      error = null;
      sendError = null;
      lastMessageCount = 0;
      userHumanRequired = false;

      stopAutoUpdate(); // Зупиняємо всі інтервали
      loadMessages();
      fetchUserStatus();
      loadAlaraStatus();
      startAutoUpdate(); // Запускаємо знову для нового користувача
    }, 200);
  }
</script>

<div
  class="chat-container"
  class:fullscreen={isFullscreen}
  class:dark={$themeStore === "dark"}
  class:light={$themeStore === "light"}
  style={getChatBackgroundStyle()}
>
  <!-- Header чату -->
  <div class="chat-header">
    <button
      class="back-button"
      on:click={onBackToList}
      aria-label="Back to user list"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M15 18L9 12L15 6"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <div class="user-info">
      <!-- Замініть цю секцію в header -->
      <div class="user-details">
        <h2>
          {selectedUser.name || selectedUser.display_name || "Unknown User"}
          {#if selectedUser.username && selectedUser.platform}
            {#if ["Telegram", "telegram", "TELEGRAM"].includes(selectedUser.platform)}
              &nbsp;(<a
                href={"https://t.me/" + selectedUser.username}
                target="_blank"
                rel="noopener noreferrer"
              >
                @{selectedUser.username}
              </a>)
            {:else if ["Instagram", "instagram", "INSTAGRAM"].includes(selectedUser.platform)}
              &nbsp;(<a
                href={"https://instagram.com/" + selectedUser.username}
                target="_blank"
                rel="noopener noreferrer"
              >
                @{selectedUser.username}
              </a>)
            {/if}
          {/if}
        </h2>

        <div class="status">
          <span class="status-text">{statusInfo.label}</span>
          <div
            class="status-indicator"
            style="background-color: {statusInfo.color}"
          ></div>
        </div>
      </div>
    </div>
    <div class="header-actions">
      <div class="platform-badge">
        {selectedUser.platform}
      </div>

      <button
        class="alara-toggle-button"
        class:enabled={currentAlaraStatus}
        class:disabled={!currentAlaraStatus}
        on:click={initiateAlaraToggle}
        disabled={togglingAlara}
        aria-label={currentAlaraStatus ? "Disable Alara" : "Enable Alara"}
        title={currentAlaraStatus ? "Put Alara to sleep" : "Wake up Alara"}
      >
        {#if togglingAlara}
          <div class="alara-spinner"></div>
        {:else}
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {#if currentAlaraStatus}
              <!-- Sleep/Off icon - простий кружок з лінією -->
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                stroke-width="2"
                fill="none"
              />
              <line
                x1="5"
                y1="8"
                x2="11"
                y2="8"
                stroke="currentColor"
                stroke-width="2"
              />
            {:else}
              <!-- Active/On icon - кружок з крапкою -->
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                stroke-width="2"
                fill="none"
              />
              <circle cx="8" cy="8" r="2" fill="currentColor" />
            {/if}
          </svg>
        {/if}
        <span>{currentAlaraStatus ? "Sleep Alara" : "Wake Alara"}</span>
      </button>

      <!-- Відображення помилки Alara статусу -->
      {#if alaraError}
        <div class="alara-error">
          <p>Alara Error: {alaraError}</p>
          <button on:click={() => (alaraError = null)} class="dismiss-error"
            >×</button
          >
        </div>
      {/if}

      <button
        class="transfer-ai-button"
        class:inactive={!isHumanRequired}
        on:click={initiateTransferToAI}
        disabled={transferringToAI || !isHumanRequired}
        aria-label="Transfer to AI"
        title={isHumanRequired
          ? "Transfer user back to AI bot"
          : "User is already handled by AI"}
      >
        {#if transferringToAI}
          <div class="transfer-spinner"></div>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2L2 7L12 12L22 7L12 2Z"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M2 17L12 22L22 17"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M2 12L12 17L22 12"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {/if}
        <span>To Alara</span>
      </button>

      <!-- Кнопка повноекранного режиму -->
      <button
        class="fullscreen-button"
        on:click={onToggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      >
        {#if isFullscreen}
          <!-- Іконка виходу з повноекранного режиму -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 9L5 5M5 5v4M5 5h4M15 15l4 4m0-4v4m0 0h-4" />
          </svg>
        {:else}
          <!-- Іконка входу в повноекранний режим -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"
            />
          </svg>
        {/if}

        {#if transferError}
          <div class="transfer-error">
            <p>Transfer Error: {transferError}</p>
            <button
              on:click={() => (transferError = null)}
              class="dismiss-error"
            >
              ×
            </button>
          </div>
        {/if}
      </button>
    </div>
  </div>

  <div class="chat-content">
    <!-- Область повідомлень -->
    <!-- Область повідомлень -->
    <div class="messages-container" bind:this={messagesContainer}>
      {#if loading}
        <div class="loading-messages">
          <div class="loading-spinner"></div>
          <p>Loading messages...</p>
        </div>
      {:else if error}
        <div class="error-messages">
          <p>Error loading messages: {error}</p>
          <button on:click={() => loadMessages()} class="retry-button">
            Retry
          </button>
        </div>
      {:else if messages.length === 0}
        <div class="no-messages">
          <p>No messages yet. Start a conversation!</p>
        </div>
      {:else}
        {#each groupedAllMessages as { date, messages: dayMessages }}
          <div class="date-separator">
            <span class="date-label">{date}</span>
          </div>
          {#each dayMessages as message (message.id)}
            <div
              class="message {message.sender}"
              class:new-message={message.isNew}
            >
              <!-- Аватар зліва для повідомлень користувача -->
              {#if message.sender === "user"}
                <div
                  class="avatar"
                  style="background: {getUserGradient(selectedUser.id)}"
                ></div>
              {/if}
              <div class="message-content">
                <p>{message.text}</p>
                <span class="timestamp">{message.timestamp}</span>
              </div>
              <!-- Аватар справа для повідомлень бота -->
              {#if message.sender === "bot"}
                <div
                  class="avatar"
                  style:background-image={`url('${alara}')`}
                  style:background-size="cover"
                ></div>
              {/if}

              {#if message.sender === "admin"}
                <div
                  class="avatar"
                  style:background-image={`url('${admin}')`}
                  style:background-size="cover"
                ></div>
              {/if}
            </div>
          {/each}
        {/each}
      {/if}
    </div>
  </div>

  <!-- Поле для введення повідомлення -->
  <div class="message-input-container">
    <input
      type="text"
      bind:value={newMessage}
      on:keydown={handleKeydown}
      placeholder="Write a message..."
      class="message-input"
      disabled={loading || sendingMessage}
    />
    <button
      class="send-button"
      on:click={sendMessage}
      disabled={newMessage.trim() === "" || loading || sendingMessage}
      aria-label="Send message"
    >
      {#if sendingMessage}
        <div class="sending-spinner"></div>
      {:else}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M22 2L11 13"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M22 2L15 22L11 13L2 9L22 2Z"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      {/if}
    </button>
    <button
      class="history-button"
      on:click={toggleHistory}
      aria-label="Toggle history"
    >
      <img
        src={hisIcon}
        alt="Toggle history"
        style="width: 20px; height: 20px;"
      />
    </button>
  </div>

  <!-- Відображення помилки відправки -->
  {#if sendError}
    <div class="send-error">
      <p>Error: {sendError}</p>
      <button on:click={() => (sendError = null)} class="dismiss-error"
        >×</button
      >
    </div>
  {/if}
</div>

<!-- Панель історії -->
{#if showHistory}
  <div
    class="history-panel"
    class:show={showHistory}
    class:dark={$themeStore === "dark"}
    class:light={$themeStore === "light"}
  >
    <div class="history-header">
      <div style="display: flex; gap: 8px; align-items: center;">
        <h3>Chat History (User Messages)</h3>
        <img
          src={hisIcon}
          alt=""
          style="width: 16px; height: 16px; margin-top: 2px;"
        />
      </div>
      <!-- <button
                class="alara-toggle-button"
                class:enabled={isAlaraEnabled}
                class:disabled={!isAlaraEnabled}
                on:click={handleAlaraToggle}
            >
                {isAlaraEnabled ? "Turn Off Alara" : "Turn On Alara"}
            </button>-->
      <button
        class="close-history-button"
        on:click={toggleHistory}
        aria-label="Close history"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M18 6L6 18M6 6L18 18"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
    <div class="history-content">
      <div class="chat-content-history">
        <div class="messages-container-history">
          {#if loading}
            <div class="loading-messages">
              <div class="loading-spinner"></div>
              <p>Loading messages...</p>
            </div>
          {:else if error}
            <div class="error-messages">
              <p>Error loading messages: {error}</p>
              <button on:click={() => loadMessages()} class="retry-button">
                Retry
              </button>
            </div>
          {:else if messages.length === 0}
            <div class="no-messages">
              <p>No messages yet. Start a conversation!</p>
            </div>
          {:else}
            <!-- Закомментировано для предотвращения дублирования сообщений
            {#each groupedAllMessages as { date, messages: dayMessages }}
              <div class="date-separator">
                <span class="date-label">{date}</span>
              </div>
              {#each dayMessages as message (message.id)}
                {#if message.sender === "user"}
                  <div class="history-message-item">
                    <div class="message-content-history">
                      <p>{message.text}</p>
                      <span class="timestamp">{message.timestamp}</span>
                    </div>
                  </div>
                {/if}
              {/each}
            {/each}
            -->
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Модальне вікно підтвердження передачі до AI -->
{#if showTransferModal}
  <div
    class="modal-overlay"
    on:click={cancelTransferToAI}
    on:keydown={handleTransferModalKeydown}
    role="dialog"
    aria-modal="true"
  >
    <div
      class="modal-content"
      class:dark={$themeStore === "dark"}
      class:light={$themeStore === "light"}
      on:click|stopPropagation
      role="document"
    >
      <h3>Transfer user to Alara?</h3>
      <p>
        This user will be transferred back to AI bot (Alara) for automatic
        responses
      </p>
      <div class="modal-actions">
        <button class="cancel-button" on:click={cancelTransferToAI}>
          Cancel
        </button>
        <button class="confirm-button" on:click={confirmTransferToAI}>
          Yes, I want
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Модальне вікно підтвердження зміни статусу Alara -->
{#if showAlaraToggleModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="modal-overlay"
    on:click={cancelAlaraToggle}
    on:keydown={handleAlaraModalKeydown}
    role="dialog"
    aria-modal="true"
  >
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="modal-content"
      class:dark={$themeStore === "dark"}
      class:light={$themeStore === "light"}
      on:click|stopPropagation
      role="document"
    >
      <h3>
        {pendingAlaraAction === "disable"
          ? "Put Alara to sleep for this chat?"
          : "Wake up Alara for this chat?"}
      </h3>
      <p>
        {pendingAlaraAction === "disable"
          ? "Alara will stop responding to messages in this chat. The user will only receive responses from human operators"
          : "Alara will start responding to messages in this chat again automatically."}
      </p>
      <div class="modal-actions">
        <button class="cancel-button" on:click={cancelAlaraToggle}>
          Cancel
        </button>
        <button class="confirm-button" on:click={confirmAlaraToggle}>
          Yes, I want
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .chat-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    position: relative;
    background-size: contain;
    background-position: center center;
    transition:
      background-color 0.3s ease,
      color 0.3s ease;
  }

  .history-message.user {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 12px;
    padding: 8px;
    border-radius: 8px;
    background: var(--user-message-bg, #f3f4f6);
  }

  .dark .history-message.user {
    background: #374151;
  }

  .history-message .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .history-message .message-content {
    flex: 1;
  }

  .history-message .message-content p {
    margin: 0 0 4px 0;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.4;
  }

  .history-message .timestamp {
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.7;
  }

  .date-group {
    margin-bottom: 16px;
  }

  .date-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 8px;
    padding: 4px 8px;
    background: var(--bg-secondary);
    border-radius: 4px;
    text-align: center;
  }

  .dark .date-header {
    background: #1f2937;
    color: #9ca3af;
  }

  /* Темна тема */
  .chat-container.dark {
    color: #fff;
  }

  /* Світла тема */
  .chat-container.light {
    color: #1a1a1a;
  }

  /* Додаємо overlay для кращої читабельності тексту на зображеннях */
  .chat-container::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 0;
    transition: background 0.3s ease;
  }

  .chat-container.dark::before {
    background: rgba(0, 0, 0, 0.4);
  }

  .chat-container.light::before {
    background: rgba(255, 255, 255, 0.4);
  }

  /* Забезпечуємо, що весь контент знаходиться поверх overlay */
  .chat-header,
  .chat-content,
  .message-input-container {
    position: relative;
    z-index: 1;
  }

  .date-separator {
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 20px 0 10px 0;
    position: relative;
  }

  .date-separator::before {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-color, #e5e7eb);
    margin-right: 16px;
  }

  /* Додати ці стилі до існуючих стилів панелі історії */

  /* Основні стилі для панелі історії з темами */
  .history-panel.dark .history-content {
    color: #fff;
  }

  .history-panel.light .history-content {
    color: #1a1a1a;
  }

  /* Стилі для повідомлень в історії */
  .history-panel.dark .message-content-history {
    background-color: #2a2a2a;
    color: #fff;
  }

  .history-panel.light .message-content-history {
    background-color: #f3f4f6;
    color: #1a1a1a;
  }

  .history-panel.dark .message-content-history p {
    color: #fff;
  }

  .history-panel.light .message-content-history p {
    color: #1a1a1a;
  }

  /* Стилі для timestamp в історії */
  .history-panel.dark .message-content-history .timestamp {
    color: #9b9ca3;
  }

  .history-panel.light .message-content-history .timestamp {
    color: #6b7280;
  }

  /* Стилі для date-separator в історії */
  .history-panel.dark .date-separator::before,
  .history-panel.dark .date-separator::after {
    background: #374151;
  }

  .history-panel.light .date-separator::before,
  .history-panel.light .date-separator::after {
    background: #e5e7eb;
  }

  .history-panel.dark .date-label {
    background: #1f2937;
    color: #9ca3af;
  }

  .history-panel.light .date-label {
    background: #5190ee8f;
    color: #ffffff;
  }

  /* Стилі для скролбару в історії */
  .history-panel.dark .chat-content-history::-webkit-scrollbar-thumb {
    background-color: #555;
  }

  .history-panel.light .chat-content-history::-webkit-scrollbar-thumb {
    background-color: #888;
  }

  .history-panel.dark .chat-content-history::-webkit-scrollbar-track {
    background: #2a2a2a;
  }

  .history-panel.light .chat-content-history::-webkit-scrollbar-track {
    background: #f5f5f5;
  }

  /* Стилі для loading, error, no-messages в історії */
  .history-panel.dark .loading-messages,
  .history-panel.dark .error-messages,
  .history-panel.dark .no-messages {
    color: #fff;
  }

  .history-panel.light .loading-messages,
  .history-panel.light .error-messages,
  .history-panel.light .no-messages {
    color: #1a1a1a;
  }

  .history-panel.dark .loading-spinner {
    border-color: #444;
    border-top-color: transparent;
  }

  .history-panel.light .loading-spinner {
    border-color: #d1d5db;
    border-top-color: transparent;
  }

  .date-separator::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border-color, #e5e7eb);
    margin-left: 16px;
  }

  .date-label {
    background: #5190ee8f;
    color: #fff;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .dark .date-separator::before,
  .dark .date-separator::after {
    background: #374151;
  }

  .dark .date-label {
    background: #1f2937;
    color: #9ca3af;
  }

  .chat-container.fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1000;
  }

  .chat-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
    border-bottom: 1px solid;
    transition:
      background-color 0.3s ease,
      border-color 0.3s ease;
  }

  .chat-container.dark .chat-header {
    border-bottom-color: #3b3b3b;
    background-color: #070709;
  }

  .chat-container.light .chat-header {
    border-bottom-color: #e5e5e5;
    background-color: #f9f9fb !important;
  }

  .back-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 8px;
    border-radius: 4px;
    transition:
      background-color 0.2s ease,
      color 0.3s ease;
  }

  .chat-container.dark .back-button {
    color: #fff;
  }

  .chat-container.light .back-button {
    color: #1a1a1a;
  }

  .chat-container.dark .back-button:hover {
    background-color: #444;
  }

  .chat-container.light .back-button:hover {
    background-color: #f0f0f0;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
  }

  .avatar {
    width: 30px;
    height: 30px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    position: relative;
  }

  .initials {
    font-size: 12px;
    font-weight: 600;
    color: #fff;
  }

  .user-details h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    transition: color 0.3s ease;
  }

  .chat-container.dark .user-details h2 {
    color: #fff;
  }

  .chat-container.light .user-details h2 {
    color: #1a1a1a;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
  }

  .status-text {
    font-size: 12px;
    transition: color 0.3s ease;
  }

  .chat-container.dark .status-text {
    color: #9b9ca3;
  }

  .chat-container.light .status-text {
    color: #6b7280;
  }

  .status-indicator {
    width: 8px;
    height: 8px;
    margin-top: 2px;
    border-radius: 50%;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .platform-badge {
    border: 1px solid;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    text-transform: capitalize;
    transition:
      border-color 0.3s ease,
      color 0.3s ease;
  }

  .chat-container.dark .platform-badge {
    border-color: #2b2b2b;
    color: #fff;
  }

  .chat-container.light .platform-badge {
    border-color: #d1d5db;
    color: #374151;
  }

  .fullscreen-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4.5px;
    border-radius: 4px;
    transition:
      background-color 0.2s ease,
      color 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chat-container.dark .fullscreen-button {
    color: #fff;
  }

  .chat-container.dark .fullscreen-button:hover {
    background-color: #444;
  }

  .chat-container.light .fullscreen-button:hover {
    background-color: #e2e2e2;
  }

  .chat-content {
    display: flex;
    flex: 1;
    position: relative;
    flex-direction: column;
    max-height: 100%;
    overflow-y: auto;
  }

  .chat-content-history {
    padding-bottom: 0%;
  }

  /* Chrome, Edge, Safari */
  .chat-content-history::-webkit-scrollbar {
    width: 8px;
  }

  .chat-content-history::-webkit-scrollbar-track {
    background: transparent;
  }

  .chat-content-history::-webkit-scrollbar-thumb {
    background-color: #888;
    border-radius: 4px;
    border: 2px solid transparent;
  }

  .chat-content-history::-webkit-scrollbar-thumb:hover {
    background-color: #666;
  }

  .messages-container {
    flex: 1;
    height: 100%;
    padding: 40px 80px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;

    scrollbar-width: none; /* Firefox: сховати скрол */
  }

  .messages-container-history {
    flex: 1;
    height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }

  /* Приховати скролбар у WebKit браузерах */
  .messages-container::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  /* Приховати скролбар за замовчуванням */
  .messages-container::-webkit-scrollbar {
    width: 0;
  }

  /* Показати на hover */
  .messages-container:hover::-webkit-scrollbar {
    width: 8px;
  }

  /* Трек і повзунок */
  .messages-container::-webkit-scrollbar-track {
    background: #e6f0f3;
    border-radius: 4px;
  }

  .messages-container::-webkit-scrollbar-thumb {
    background-color: #0077b6;
    border-radius: 4px;
    border: 2px solid #e6f0f3;
  }

  .message {
    display: flex;
    gap: 14px;
    max-width: 56%;
    animation: fadeIn 0.3s ease-in-out;
  }

  .message.user {
    align-self: flex-start;
  }

  .message.bot {
    align-self: flex-end;
  }

  .message-content {
    padding: 12px 16px;
    border-radius: 10px;
    position: relative;
    flex: 1;
    transition: background-color 0.3s ease;
  }

  .message-content-history {
    padding: 12px 16px;
    border-radius: 10px;
    position: relative;
    background-color: #1f2937;
    flex: 1;
    transition: background-color 0.3s ease;
  }

  .chat-container.dark .message.user .message-content {
    background-color: #2a2a2a;
  }

  .chat-container.light .message.user .message-content {
    background-color: #f3f4f6;
  }

  .chat-container.dark .message.bot .message-content {
    background-color: #530549;
  }

  .chat-container.light .message.bot .message-content {
    background-color: #e7e5f4;
  }

  .message-content p {
    margin: 0;
    font-size: 14px;
    line-height: 1.4;
    margin-bottom: 4px;
    word-wrap: break-word;
    transition: color 0.3s ease;
  }

  .message-content-history p {
    margin: 0;
    font-size: 14px;
    line-height: 1.4;
    margin-bottom: 4px;
    word-wrap: break-word;
    transition: color 0.3s ease;
  }

  .chat-container.dark .message-content p {
    color: #fff;
  }

  .chat-container.light .message-content p {
    color: #1a1a1a;
  }

  .timestamp {
    font-size: 11px;
    opacity: 0.7;
    transition: color 0.3s ease;
  }

  .chat-container.dark .timestamp {
    color: #9b9ca3;
  }

  .chat-container.light .timestamp {
    color: #6b7280;
  }

  .user-avatar {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  }

  .loading-messages,
  .error-messages,
  .no-messages {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 16px;
    padding: 40px;
    text-align: center;
  }

  .loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid;
    border-radius: 50%;
    border-top-color: transparent;
    animation: spin 1s linear infinite;
    transition: border-color 0.3s ease;
  }

  .chat-container.dark .loading-spinner {
    border-color: #444;
    border-top-color: transparent;
  }

  .chat-container.light .loading-spinner {
    border-color: #d1d5db;
    border-top-color: transparent;
  }

  .retry-button {
    background-color: #667eea;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s ease;
  }

  .retry-button:hover {
    background-color: #5a67d8;
  }

  .message-input-container {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 80px;
    border-top: 1px solid;
    transition:
      background-color 0.3s ease,
      border-color 0.3s ease;
  }

  .chat-container.dark .message-input-container {
    border: none;
  }

  .chat-container.light .message-input-container {
    border-top-color: #e5e5e5;
    background-color: #f9f9fb;
  }

  .message-input {
    flex: 1;
    padding: 12px 16px;
    border: 1px solid;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    transition:
      border-color 0.2s ease,
      background-color 0.3s ease,
      color 0.3s ease;
  }

  .chat-container.dark .message-input {
    background-color: #2a2a2a;
    border-color: #444;
    color: #fff;
  }

  .chat-container.light .message-input {
    background-color: #fff;
    border-color: #d1d5db;
    color: #1a1a1a;
  }

  .chat-container.dark .message-input::placeholder {
    color: #9b9ca3;
  }

  .chat-container.light .message-input::placeholder {
    color: #6b7280;
  }

  .chat-container.dark .message-input:focus {
    border-color: #667eea;
  }

  .chat-container.light .message-input:focus {
    border-color: #667eea;
  }

  .send-button,
  .history-button {
    background-color: var(--color-530549);
    color: white;
    border: none;
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.2s ease;
    min-width: 44px;
    height: 44px;
  }

  .send-button:hover:not(:disabled),
  .history-button:hover {
    background-color: var(--color-8a0778);
  }

  .send-button:disabled {
    background-color: var(--color-530549);
    cursor: not-allowed;
  }

  .history-panel {
    position: fixed;
    top: 0;
    right: -400px;
    width: 400px;
    height: 100%;
    border-left: 1px solid;
    display: flex;
    flex-direction: column;
    transition:
      right 0.3s ease,
      background-color 0.3s ease,
      border-color 0.3s ease;
    z-index: 1001;
  }

  .history-panel.dark {
    background-color: #1a1a1a;
    border-left-color: #3b3b3b;
  }

  .history-panel.light {
    background-color: #fff;
    border-left-color: #e5e5e5;
  }

  .history-panel.show {
    right: 0;
  }

  .history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 24.5px 20px;
    border-bottom: 1px solid;
    transition: border-color 0.3s ease;
  }

  .history-panel.dark .history-header {
    border-bottom-color: #3b3b3b;
  }

  .history-panel.light .history-header {
    border-bottom-color: #e5e5e5;
  }

  .alara-toggle-button {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .alara-toggle-button.enabled {
    background-color: #ef4444;
    color: white;
  }

  .alara-toggle-button.enabled:hover {
    background-color: #dc2626;
  }

  .alara-toggle-button.disabled {
    background-color: #10b981;
    color: white;
  }

  .alara-toggle-button.disabled:hover {
    background-color: #059669;
  }

  .close-history-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 8px;
    border-radius: 4px;
    transition:
      background-color 0.2s ease,
      color 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .history-panel.dark .close-history-button {
    color: #fff;
  }

  .history-panel.light .close-history-button {
    color: #1a1a1a;
  }

  .history-panel.dark .close-history-button:hover {
    background-color: #444;
  }

  .history-panel.light .close-history-button:hover {
    background-color: #f0f0f0;
  }

  .history-content {
    flex: 1;
    padding: 20px;
    height: 100%;
    overflow-y: auto;
    scrollbar-width: thin; /* для Firefox */
    scrollbar-color: #88888800 transparent; /* колір треку та ползунка */
  }

  .history-content h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 600;
    transition: color 0.3s ease;
  }

  .history-panel.dark .history-content h3 {
    color: #fff;
  }

  .history-panel.light .history-content h3 {
    color: #1a1a1a;
  }

  .no-history {
    font-size: 14px;
    opacity: 0.7;
    text-align: center;
    margin-top: 40px;
    transition: color 0.3s ease;
  }

  .history-panel.dark .no-history {
    color: #9b9ca3;
  }

  .history-panel.light .no-history {
    color: #6b7280;
  }

  .date-group {
    margin-bottom: 24px;
  }

  .date-header {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 12px;
    padding-bottom: 4px;
    border-bottom: 1px solid;
    transition:
      color 0.3s ease,
      border-color 0.3s ease;
  }

  .history-panel.dark .date-header {
    color: #9b9ca3;
    border-bottom-color: #3b3b3b;
  }

  .history-panel.light .date-header {
    color: #6b7280;
    border-bottom-color: #e5e5e5;
  }

  .history-message {
    margin-bottom: 12px;
    padding: 8px 12px;
    border-radius: 6px;
    transition: background-color 0.3s ease;
  }

  .history-panel.dark .history-message {
    background-color: #2a2a2a;
  }

  .history-panel.light .history-message {
    background-color: #f9f9fb;
  }

  .history-timestamp {
    font-size: 11px;
    opacity: 0.7;
    display: block;
    margin-bottom: 4px;
    transition: color 0.3s ease;
  }

  .history-panel.dark .history-timestamp {
    color: #9b9ca3;
  }

  .history-panel.light .history-timestamp {
    color: #6b7280;
  }

  .history-text {
    margin: 0;
    font-size: 13px;
    line-height: 1.4;
    word-wrap: break-word;
    transition: color 0.3s ease;
  }

  .history-panel.dark .history-text {
    color: #fff;
  }

  .history-panel.light .history-text {
    color: #1a1a1a;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    animation: fadeIn 0.2s ease-out;
  }

  .modal-content {
    padding: 24px;
    border-radius: 8px;
    max-width: 400px;
    width: 90%;
    animation: slideIn 0.2s ease-out;
    transition: background-color 0.3s ease;
  }

  .modal-content.dark {
    background-color: #1a1a1a;
    color: #fff;
  }

  .modal-content.light {
    background-color: #fff;
    color: #1a1a1a;
  }

  .modal-content h3 {
    margin: 0 0 12px 0;
    font-size: 18px;
    font-weight: 600;
  }

  .modal-content p {
    margin: 0 0 20px 0;
    font-size: 14px;
    line-height: 1.5;
    opacity: 0.8;
  }

  .modal-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
  }

  /* Загальні стилі для кнопок */
  .cancel-button,
  .confirm-button {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition:
      background-color 0.25s ease,
      color 0.25s ease,
      border-color 0.25s ease;
  }

  /* ===== Cancel Button ===== */
  .cancel-button {
    background-color: transparent;
    color: #ef4444;
    border-color: #ef4444;
  }

  .cancel-button:hover {
    background-color: #ef444410;
    border-color: #ef4444;
  }

  /* ===== Confirm Button ===== */
  .confirm-button {
    background-color: #2563eb;
    color: white;
    border-color: #2563eb;
  }

  .confirm-button:hover {
    background-color: #1e40af;
    border-color: #1e40af;
  }

  /* ===== Темна тема ===== */
  .modal-content.dark .cancel-button {
    background-color: transparent;
    color: #f87171;
    border-color: #f87171;
  }

  .modal-content.dark .cancel-button:hover {
    background-color: #f8717115;
  }

  .modal-content.dark .confirm-button {
    background-color: #3b82f6;
    color: white;
    border-color: #3b82f6;
  }

  .modal-content.dark .confirm-button:hover {
    background-color: #1d4ed8;
    border-color: #1d4ed8;
  }

  /* ===== Світла тема ===== */
  .modal-content.light .cancel-button {
    background-color: transparent;
    color: #dc2626;
    border-color: #dc2626;
  }

  .modal-content.light .cancel-button:hover {
    background-color: #dc262610;
  }

  .modal-content.light .confirm-button {
    background-color: #2563eb;
    color: white;
    border-color: #2563eb;
  }

  .modal-content.light .confirm-button:hover {
    background-color: #1d4ed8;
    border-color: #1d4ed8;
  }

  .connection-status {
    position: absolute;
    top: 10px;
    right: 20px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 10;
  }

  .connection-status.offline {
    background-color: #ef4444;
    color: white;
  }

  .typing-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    font-size: 12px;
    opacity: 0.7;
    animation: fadeIn 0.3s ease;
  }

  .typing-dots {
    display: flex;
    gap: 2px;
  }

  .typing-dots span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background-color: currentColor;
    animation: typingDot 1.4s infinite;
  }

  .typing-dots span:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing-dots span:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typingDot {
    0%,
    60%,
    100% {
      opacity: 0.3;
    }
    30% {
      opacity: 1;
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

  @keyframes slideIn {
    from {
      transform: translateY(-20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .messages-container {
      padding-left: 20px;
      padding-right: 20px;
    }

    .message {
      max-width: 85%;
    }

    .history-panel {
      width: 100%;
      right: -100%;
    }

    .chat-header {
      padding: 12px 16px;
    }

    .message-input-container {
      padding: 12px 16px;
    }

    .user-details h2 {
      font-size: 14px;
    }

    .platform-badge {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .messages-container {
      padding-left: 12px;
      padding-right: 12px;
      padding-top: 20px;
      padding-bottom: 20px;
    }

    .message {
      max-width: 95%;
    }

    .message-content {
      padding: 10px 12px;
    }

    .message-content p {
      font-size: 13px;
    }

    .header-actions {
      gap: 8px;
    }

    .fullscreen-button {
      padding: 6px;
    }

    .modal-content {
      margin: 20px;
      padding: 20px;
    }
  }

  .message.admin {
    align-self: flex-end;
  }

  .chat-container.dark .message.admin .message-content {
    background-color: #1e40af;
  }

  .chat-container.light .message.admin .message-content {
    background-color: #dbeafe;
  }

  /* Мінімалістична кнопка передачі до AI */
  .transfer-ai-button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #f3f4f6;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .transfer-ai-button:hover:not(:disabled):not(.inactive) {
    background: #e5e7eb;
    border-color: #9ca3af;
  }

  .transfer-ai-button:active:not(:disabled):not(.inactive) {
    background: #d1d5db;
  }

  .transfer-ai-button:disabled,
  .transfer-ai-button.inactive {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .transfer-spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid #d1d5db;
    border-top: 1.5px solid #374151;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  /* Помилка передачі до AI - мінімалістична */
  .transfer-error {
    position: absolute;
    bottom: 80px;
    left: 20px;
    right: 20px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 1000;
  }

  .transfer-error p {
    margin: 0;
    color: #dc2626;
    font-size: 13px;
  }

  .dismiss-error {
    background: none;
    border: none;
    color: #dc2626;
    cursor: pointer;
    font-size: 16px;
    padding: 0;
    margin-left: 8px;
  }

  /* Темна тема */
  .dark .transfer-ai-button {
    background: #374151;
    color: #f9fafb;
    border-color: #4b5563;
  }

  .dark .transfer-ai-button:hover:not(:disabled):not(.inactive) {
    background: #4b5563;
    border-color: #6b7280;
  }

  .dark .transfer-ai-button:active:not(:disabled):not(.inactive) {
    background: #6b7280;
  }

  .dark .transfer-spinner {
    border-color: #6b7280;
    border-top-color: #f9fafb;
  }

  .dark .transfer-error {
    background: #1f2937;
    border-color: #374151;
  }

  .dark .transfer-error p {
    color: #f87171;
  }

  .dark .dismiss-error {
    color: #f87171;
  }

  /* Адаптивність */
  @media (max-width: 768px) {
    .transfer-ai-button span {
      display: none;
    }

    .transfer-ai-button {
      padding: 6px;
      min-width: 28px;
      justify-content: center;
    }
  }
  /* Мінімалістична кнопка керування Alara */
  .alara-toggle-button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .alara-toggle-button.enabled {
    background: #f0fdf4;
    color: #166534;
    border-color: #bbf7d0;
  }

  .alara-toggle-button.disabled {
    background: #fef2f2;
    color: #dc2626;
    border-color: #fecaca;
  }

  .alara-toggle-button.enabled:hover:not(:disabled) {
    background: #dcfce7;
    border-color: #86efac;
  }

  .alara-toggle-button.disabled:hover:not(:disabled) {
    background: #fee2e2;
    border-color: #fca5a5;
  }

  .alara-toggle-button.enabled:active:not(:disabled) {
    background: #bbf7d0;
  }

  .alara-toggle-button.disabled:active:not(:disabled) {
    background: #fecaca;
  }

  .alara-toggle-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .alara-spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid #d1d5db;
    border-top: 1.5px solid currentColor;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  /* Помилка Alara - мінімалістична */
  .alara-error {
    position: absolute;
    bottom: 120px;
    left: 20px;
    right: 20px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 1000;
  }

  .alara-error p {
    margin: 0;
    color: #dc2626;
    font-size: 13px;
  }

  .dismiss-alara-error {
    background: none;
    border: none;
    color: #dc2626;
    cursor: pointer;
    font-size: 16px;
    padding: 0;
    margin-left: 8px;
  }

  /* Темна тема */
  .dark .alara-toggle-button.enabled {
    background: #064e3b;
    color: #6ee7b7;
    border-color: #047857;
  }

  .dark .alara-toggle-button.disabled {
    background: #1f2937;
    color: #f87171;
    border-color: #374151;
  }

  .dark .alara-toggle-button.enabled:hover:not(:disabled) {
    background: #065f46;
    border-color: #059669;
  }

  .dark .alara-toggle-button.disabled:hover:not(:disabled) {
    background: #374151;
    border-color: #4b5563;
  }

  .dark .alara-toggle-button.enabled:active:not(:disabled) {
    background: #047857;
  }

  .dark .alara-toggle-button.disabled:active:not(:disabled) {
    background: #4b5563;
  }

  .dark .alara-spinner {
    border-color: #6b7280;
    border-top-color: currentColor;
  }

  .dark .alara-error {
    background: #1f2937;
    border-color: #374151;
  }

  .dark .alara-error p {
    color: #f87171;
  }

  .dark .dismiss-alara-error {
    color: #f87171;
  }

  /* Адаптивність */
  @media (max-width: 768px) {
    .alara-toggle-button span {
      display: none;
    }
    .alara-toggle-button {
      padding: 6px;
      min-width: 28px;
      justify-content: center;
    }
  }
</style>
