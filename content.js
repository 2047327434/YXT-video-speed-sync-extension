/**
 * content.js - 注入页面，负责视频检测、倍速控制、进度同步
 */

(function () {
  'use strict';

  // 避免重复注入
  if (window.__videoSpeedSyncInjected) return;
  window.__videoSpeedSyncInjected = true;

  // ==================== 状态管理 ====================
  const state = {
    videos: [],           // 检测到的视频元素
    currentSpeed: 1.0,    // 当前倍速
    syncEnabled: false,   // 是否开启联网同步
    syncRoomId: '',       // 同步房间ID
    ws: null,             // WebSocket 连接
    wsUrl: 'wss://your-sync-server.com/ws', // 默认同步服务器地址
    isMaster: false,      // 是否为主控端
    lastReportedTime: 0,  // 上次上报进度时间
    ignoreNextEvent: false, // 忽略下一次事件（防止循环触发）
    videoMeta: new Map(), // 视频元数据 (video -> {id, url})
  };

  // ==================== 视频检测 ====================

  /**
   * 扫描页面中的所有视频元素
   */
  function scanVideos() {
    const videos = Array.from(document.querySelectorAll('video'));
    const iframes = Array.from(document.querySelectorAll('iframe'));

    // 处理 iframe 中的视频（如果同源）
    iframes.forEach(iframe => {
      try {
        const iframeVideos = iframe.contentDocument?.querySelectorAll('video');
        if (iframeVideos) videos.push(...Array.from(iframeVideos));
      } catch (e) {
        // 跨域 iframe，无法访问
      }
    });

    // 过滤掉已销毁的视频
    state.videos = videos.filter(v => document.contains(v) || v.isConnected);

    // 为新视频绑定事件
    state.videos.forEach(video => {
      if (!state.videoMeta.has(video)) {
        bindVideoEvents(video);
      }
    });

    return state.videos;
  }

  /**
   * 为视频元素生成唯一ID
   */
  function getVideoId(video) {
    if (!state.videoMeta.has(video)) {
      const id = 'v_' + Math.random().toString(36).substr(2, 9);
      state.videoMeta.set(video, {
        id,
        url: video.currentSrc || video.src || location.href,
        title: document.title,
        pageUrl: location.href
      });
    }
    return state.videoMeta.get(video).id;
  }

  /**
   * 绑定视频事件
   */
  function bindVideoEvents(video) {
    const videoId = getVideoId(video);

    // 播放事件
    video.addEventListener('play', () => {
      if (state.ignoreNextEvent) { state.ignoreNextEvent = false; return; }
      broadcastAction('play', { videoId, currentTime: video.currentTime });
    });

    // 暂停事件
    video.addEventListener('pause', () => {
      if (state.ignoreNextEvent) { state.ignoreNextEvent = false; return; }
      broadcastAction('pause', { videoId, currentTime: video.currentTime });
    });

    // 进度跳转事件
    video.addEventListener('seeked', () => {
      if (state.ignoreNextEvent) { state.ignoreNextEvent = false; return; }
      broadcastAction('seek', { videoId, currentTime: video.currentTime });
    });

    // 倍速变化事件
    video.addEventListener('ratechange', () => {
      if (state.ignoreNextEvent) { state.ignoreNextEvent = false; return; }
      // 如果是我们自己设置的倍速，不广播
      if (video.dataset.vssSettingSpeed === 'true') {
        delete video.dataset.vssSettingSpeed;
        return;
      }
      broadcastAction('speed', { videoId, speed: video.playbackRate });
    });

    // 定期上报进度（主控端）
    setInterval(() => {
      if (state.syncEnabled && state.isMaster && !video.paused) {
        const now = Date.now();
        if (now - state.lastReportedTime > 3000) { // 每3秒上报一次
          broadcastAction('progress', {
            videoId,
            currentTime: video.currentTime,
            speed: video.playbackRate
          });
          state.lastReportedTime = now;
        }
      }
    }, 1000);
  }

  // ==================== 倍速控制 ====================

  /**
   * 设置所有视频的倍速
   */
  function setSpeed(speed) {
    state.currentSpeed = parseFloat(speed);
    scanVideos().forEach(video => {
      video.dataset.vssSettingSpeed = 'true';
      video.playbackRate = state.currentSpeed;
    });

    // 保存到 storage
    chrome.storage.local.set({ vss_speed: state.currentSpeed });

    // 广播倍速变化
    if (state.syncEnabled && state.isMaster) {
      state.videos.forEach(video => {
        broadcastAction('speed', { videoId: getVideoId(video), speed: state.currentSpeed });
      });
    }
  }

  /**
   * 加速/减速微调
   */
  function adjustSpeed(delta) {
    const newSpeed = Math.max(0.25, Math.min(20, state.currentSpeed + delta));
    setSpeed(newSpeed);
  }

  // ==================== 联网同步 ====================

  /**
   * 连接同步服务器
   */
  function connectSync(url, roomId, asMaster = false) {
    disconnectSync();

    state.wsUrl = url;
    state.syncRoomId = roomId;
    state.isMaster = asMaster;
    state.syncEnabled = true;

    try {
      state.ws = new WebSocket(url);

      state.ws.onopen = () => {
        console.log('[VSS] WebSocket 已连接');
        sendWsMessage('join', { roomId });
        broadcastToPopup({ type: 'syncStatus', status: 'connected', roomId });
      };

      state.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleSyncMessage(msg);
        } catch (e) {
          console.error('[VSS] 消息解析失败:', e);
        }
      };

      state.ws.onclose = () => {
        console.log('[VSS] WebSocket 已断开');
        broadcastToPopup({ type: 'syncStatus', status: 'disconnected' });
        // 自动重连
        if (state.syncEnabled) {
          setTimeout(() => connectSync(url, roomId, asMaster), 3000);
        }
      };

      state.ws.onerror = (err) => {
        console.error('[VSS] WebSocket 错误:', err);
        broadcastToPopup({ type: 'syncStatus', status: 'error', error: '连接失败' });
      };

    } catch (e) {
      console.error('[VSS] 连接失败:', e);
      broadcastToPopup({ type: 'syncStatus', status: 'error', error: e.message });
    }
  }

  /**
   * 断开同步服务器
   */
  function disconnectSync() {
    state.syncEnabled = false;
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
  }

  /**
   * 发送 WebSocket 消息
   */
  function sendWsMessage(action, data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ action, ...data, timestamp: Date.now() }));
    }
  }

  /**
   * 广播动作到同步服务器
   */
  function broadcastAction(action, data) {
    if (!state.syncEnabled || !state.isMaster) return;
    sendWsMessage(action, data);
  }

  /**
   * 处理接收到的同步消息
   */
  function handleSyncMessage(msg) {
    // 只处理来自其他客户端的消息（非自己发出的）
    if (msg.clientId === getClientId()) return;

    const video = findVideoById(msg.videoId);
    if (!video) return;

    state.ignoreNextEvent = true;

    switch (msg.action) {
      case 'play':
        if (video.paused) video.play();
        if (msg.currentTime !== undefined) {
          video.currentTime = msg.currentTime;
        }
        break;

      case 'pause':
        if (!video.paused) video.pause();
        if (msg.currentTime !== undefined) {
          video.currentTime = msg.currentTime;
        }
        break;

      case 'seek':
        video.currentTime = msg.currentTime;
        break;

      case 'speed':
        state.currentSpeed = msg.speed;
        video.playbackRate = msg.speed;
        broadcastToPopup({ type: 'speedChanged', speed: msg.speed });
        break;

      case 'progress':
        // 进度同步：只在小范围内调整，避免跳跃
        if (msg.currentTime !== undefined) {
          const diff = Math.abs(video.currentTime - msg.currentTime);
          if (diff > 2) { // 偏差超过2秒才调整
            video.currentTime = msg.currentTime;
          }
        }
        if (msg.speed !== undefined && video.playbackRate !== msg.speed) {
          video.playbackRate = msg.speed;
          state.currentSpeed = msg.speed;
        }
        break;

      case 'join':
        // 有新成员加入，如果是主控端，发送当前状态
        if (state.isMaster) {
          const masterVideo = state.videos[0];
          if (masterVideo) {
            sendWsMessage('syncState', {
              videoId: getVideoId(masterVideo),
              currentTime: masterVideo.currentTime,
              speed: masterVideo.playbackRate,
              paused: masterVideo.paused,
              targetClient: msg.clientId
            });
          }
        }
        break;

      case 'syncState':
        // 收到主控端的状态同步
        if (msg.targetClient === getClientId()) {
          if (msg.currentTime !== undefined) video.currentTime = msg.currentTime;
          if (msg.speed !== undefined) {
            video.playbackRate = msg.speed;
            state.currentSpeed = msg.speed;
          }
          if (msg.paused !== undefined) {
            msg.paused ? video.pause() : video.play();
          }
        }
        break;
    }
  }

  /**
   * 根据ID查找视频元素
   */
  function findVideoById(videoId) {
    for (const [video, meta] of state.videoMeta) {
      if (meta.id === videoId && (document.contains(video) || video.isConnected)) {
        return video;
      }
    }
    // 如果找不到，尝试重新扫描
    scanVideos();
    for (const [video, meta] of state.videoMeta) {
      if (meta.id === videoId && (document.contains(video) || video.isConnected)) {
        return video;
      }
    }
    return null;
  }

  /**
   * 获取客户端唯一ID
   */
  function getClientId() {
    let id = sessionStorage.getItem('vss_clientId');
    if (!id) {
      id = 'c_' + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem('vss_clientId', id);
    }
    return id;
  }

  // ==================== 与 Popup / Background 通信 ====================

  /**
   * 向 popup 广播消息
   */
  function broadcastToPopup(message) {
    chrome.runtime.sendMessage({
      target: 'popup',
      ...message
    }).catch(() => {});
  }

  /**
   * 监听来自 popup / background 的消息
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target !== 'content') return;

    switch (request.action) {
      case 'getVideos':
        scanVideos();
        sendResponse({
          count: state.videos.length,
          videos: state.videos.map((v, i) => ({
            index: i,
            id: getVideoId(v),
            currentTime: v.currentTime,
            duration: v.duration,
            speed: v.playbackRate,
            paused: v.paused,
            src: v.currentSrc || v.src || '未知来源'
          }))
        });
        break;

      case 'setSpeed':
        setSpeed(request.speed);
        sendResponse({ success: true, speed: state.currentSpeed });
        break;

      case 'adjustSpeed':
        adjustSpeed(request.delta);
        sendResponse({ success: true, speed: state.currentSpeed });
        break;

      case 'togglePlay':
        {
          const video = state.videos[request.videoIndex || 0];
          if (video) {
            video.paused ? video.play() : video.pause();
            sendResponse({ success: true, paused: video.paused });
          } else {
            sendResponse({ success: false, error: '视频不存在' });
          }
        }
        break;

      case 'seek':
        {
          const video = state.videos[request.videoIndex || 0];
          if (video) {
            video.currentTime = request.time;
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: '视频不存在' });
          }
        }
        break;

      case 'connectSync':
        connectSync(request.url, request.roomId, request.asMaster);
        sendResponse({ success: true });
        break;

      case 'disconnectSync':
        disconnectSync();
        sendResponse({ success: true });
        break;

      case 'getSyncStatus':
        sendResponse({
          enabled: state.syncEnabled,
          connected: state.ws?.readyState === WebSocket.OPEN,
          roomId: state.syncRoomId,
          isMaster: state.isMaster
        });
        break;

      case 'skip':
        {
          const video = state.videos[request.videoIndex || 0];
          if (video) {
            video.currentTime += request.seconds;
            sendResponse({ success: true, currentTime: video.currentTime });
          } else {
            sendResponse({ success: false, error: '视频不存在' });
          }
        }
        break;

      default:
        sendResponse({ success: false, error: '未知操作' });
    }

    return true; // 保持消息通道开启
  });

  // ==================== 云学堂倒计时倍速补丁 v2 ====================

  /**
   * 检测并劫持云学堂课程页面的"剩余学习时间"倒计时
   *
   * v2 修复：不再读取原生DOM文本做二次除法（会导致双重加速跳0）。
   * 改为直接从 video 元素计算：
   *   真实剩余时间 = (video.duration - video.currentTime) / playbackRate
   *
   * 这样显示的是"按当前倍速，真实还需要等待多少秒"。
   *
   * ⚠️ 重要说明：此补丁仅修改前端显示，无法绕过云学堂后端的
   *    累计观看时长校验。课程完成由后端决定，倒计时只是UI提示。
   */
  (function initYxtCountdownPatch() {
    const COUNTDOWN_SELECTOR = '.yxtulcdsdk-course-player__countdown';
    const COUNTDOWN_TEXT_SELECTOR = '.yxtulcdsdk-course-player__countdown .yxt-color-warning';

    let patchInterval = null;
    let lastDisplayText = '';
    let lastVideoTime = 0;
    let lastRealTimestamp = 0;

    /**
     * 格式化秒数为 "X分钟 Y秒"
     * 最低保留 1 秒，避免直接跳到 0
     */
    function formatMinutesSeconds(totalSeconds) {
      if (totalSeconds <= 0) return '即将完成';
      const m = Math.floor(totalSeconds / 60);
      const s = Math.floor(totalSeconds % 60);
      if (m > 0) {
        return `${m}分钟 ${s}秒`;
      }
      if (s < 1) return '1秒';
      return `${s}秒`;
    }

    /**
     * 计算倍速后的真实剩余时间
     * 直接从 video 元素取数据，不依赖原生DOM文本
     */
    function getAdjustedRemainingSeconds(video, speed) {
      if (!video || !isFinite(video.duration)) return 0;
      const rawRemaining = video.duration - video.currentTime;
      if (rawRemaining <= 0) return 0;

      // 核心计算：在倍速下，真实需要等待的时间
      // 例如：剩余 200 秒内容，20x 倍速 → 真实只需等 10 秒
      return rawRemaining / speed;
    }

    /**
     * 应用倍速补丁：覆盖倒计时显示
     */
    function applyCountdownPatch() {
      const textEl = document.querySelector(COUNTDOWN_TEXT_SELECTOR);
      const containerEl = document.querySelector(COUNTDOWN_SELECTOR);
      if (!textEl || !containerEl) return;

      // 获取当前视频
      const videos = scanVideos();
      const video = videos[0];
      const speed = video ? video.playbackRate : state.currentSpeed;
      if (speed <= 1) {
        // 1x 及以下不干预，让原生逻辑正常显示
        lastDisplayText = '';
        return;
      }

      // 直接从 video 计算真实剩余时间
      const adjustedSeconds = getAdjustedRemainingSeconds(video, speed);

      // 生成新的显示文本
      const adjustedText = formatMinutesSeconds(adjustedSeconds);

      // 如果和上次显示不同，则更新（减少DOM操作）
      if (adjustedText !== lastDisplayText) {
        textEl.textContent = adjustedText;
        lastDisplayText = adjustedText;

        // 给容器添加标记
        containerEl.dataset.vssPatched = 'true';
        containerEl.dataset.vssSpeed = speed.toFixed(2);
      }
    }

    /**
     * 启动补丁定时器
     */
    function startPatch() {
      if (patchInterval) return;
      patchInterval = setInterval(applyCountdownPatch, 500); // 每500ms更新一次
      console.log('[VSS] 云学堂倒计时倍速补丁 v2 已启动');
    }

    /**
     * 停止补丁定时器
     */
    function stopPatch() {
      if (patchInterval) {
        clearInterval(patchInterval);
        patchInterval = null;
        lastDisplayText = '';
        console.log('[VSS] 云学堂倒计时倍速补丁 v2 已停止');
      }
    }

    /**
     * 监听 DOM 变化，当检测到云学堂倒计时组件出现时启动补丁
     */
    const domObserver = new MutationObserver(() => {
      const containerEl = document.querySelector(COUNTDOWN_SELECTOR);
      if (containerEl) {
        if (!patchInterval) startPatch();
      } else {
        if (patchInterval) stopPatch();
      }
    });

    domObserver.observe(document.body, { childList: true, subtree: true });

    // 立即检测一次
    if (document.querySelector(COUNTDOWN_SELECTOR)) {
      startPatch();
    }

    // 暴露控制接口到全局（方便调试）
    window.__vssCountdownPatch = { start: startPatch, stop: stopPatch };
  })();

  // ==================== 播放器倍速菜单扩展补丁 ====================

  /**
   * 扩展 jwplayer / 云学堂播放器自带的倍速菜单
   *
   * 原理：播放器原生只支持 ×1 ~ ×2，但 video.playbackRate 可以更高。
   * 我们通过 DOM 操作，往播放器的倍速下拉菜单里注入 ×3、×5、×10、×20 选项。
   *
   * 点击注入的选项时：
   *   1. 设置 video.playbackRate（触发 ratechange 事件）
   *   2. 更新播放器 UI 上的倍速标签
   *   3. 同步我们插件内部的 state.currentSpeed
   *   4. 云学堂的倒计时组件会监听到 ratechange，自动联动加速
   *
   * 这样比直接改 video.playbackRate 更"合法"——播放器事件可能被
   * 云学堂订阅，从而同步后端累计观看时长的计算。
   */
  (function initPlayerSpeedMenuPatch() {
    const MENU_SELECTOR = '.jw-menu-playrate';
    const LABEL_SELECTOR = '.jw-playrate-label';
    const EXTRA_SPEEDS = [
      { label: '×3', value: 3 },
      { label: '×5', value: 5 },
      { label: '×10', value: 10 },
      { label: '×20', value: 20 }
    ];

    /**
     * 设置播放器倍速（通过播放器菜单）
     */
    function setPlayerSpeed(speed) {
      const videos = scanVideos();
      const video = videos[0];
      if (!video) {
        console.warn('[VSS] 未找到视频，无法设置倍速');
        return false;
      }

      // 1. 设置视频倍速（这会触发 ratechange 事件）
      video.playbackRate = speed;
      state.currentSpeed = speed;

      // 2. 更新播放器倍速标签
      const label = document.querySelector(LABEL_SELECTOR);
      if (label) {
        label.textContent = `x${speed}`;
      }

      // 3. 更新菜单高亮状态
      updateMenuHighlight(speed);

      // 4. 保存到 storage
      chrome.storage.local.set({ vss_speed: speed });

      // 5. 关闭菜单
      closePlayrateMenu();

      console.log(`[VSS] 播放器倍速已设为 ${speed}x`);
      return true;
    }

    /**
     * 更新菜单高亮状态
     */
    function updateMenuHighlight(activeSpeed) {
      const menu = document.querySelector(MENU_SELECTOR);
      if (!menu) return;

      menu.querySelectorAll('.jw-option').forEach(item => {
        const itemSpeed = parseFloat(item.dataset.speed || item.textContent.replace(/[×x]/g, ''));
        if (Math.abs(itemSpeed - activeSpeed) < 0.01) {
          item.classList.add('jw-active-option');
        } else {
          item.classList.remove('jw-active-option');
        }
      });
    }

    /**
     * 关闭倍速菜单
     */
    function closePlayrateMenu() {
      const menu = document.querySelector(MENU_SELECTOR);
      if (menu) {
        menu.style.display = 'none';
      }
      // 同时移除播放器的 open 状态
      const playrateBtn = document.querySelector('.jw-icon-playrate');
      if (playrateBtn) {
        playrateBtn.classList.remove('jw-open');
      }
    }

    /**
     * 给现有选项绑定点击事件（防止原生逻辑覆盖）
     */
    function bindExistingItems(menu) {
      menu.querySelectorAll('.jw-option').forEach(item => {
        if (item.dataset.vssBound) return; // 已绑定过，跳过

        const speedText = item.textContent.trim();
        const speed = parseFloat(speedText.replace(/[×x]/g, ''));
        if (isNaN(speed)) return;

        item.dataset.speed = speed;
        item.dataset.vssBound = 'true';

        // 用捕获阶段拦截点击，确保先执行我们的逻辑
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          setPlayerSpeed(speed);
        }, true);
      });
    }

    /**
     * 向播放器倍速菜单注入新选项
     */
    function injectExtraOptions(menu) {
      // 如果已经注入过，只更新绑定
      if (menu.dataset.vssInjected === 'true') {
        bindExistingItems(menu);
        return;
      }

      // 先给现有选项绑定事件
      bindExistingItems(menu);

      // 注入分隔线和新选项
      const separator = document.createElement('li');
      separator.className = 'jw-text jw-option jw-reset';
      separator.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.2); margin: 4px 0; padding-top: 4px; pointer-events: none; opacity: 0.5;';
      separator.textContent = '—— 扩展 ——';
      menu.appendChild(separator);

      EXTRA_SPEEDS.forEach(({ label, value }) => {
        const li = document.createElement('li');
        li.className = 'jw-text jw-option jw-item-0 jw-reset';
        li.textContent = label;
        li.dataset.speed = value;
        li.style.cssText = 'color: #ffd700; font-weight: bold;';

        li.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          setPlayerSpeed(value);
        });

        menu.appendChild(li);
      });

      menu.dataset.vssInjected = 'true';
      console.log('[VSS] 播放器倍速菜单扩展完成，新增：×3 ×5 ×10 ×20');
    }

    /**
     * 尝试 patch 菜单
     */
    function tryPatchMenu() {
      const menu = document.querySelector(MENU_SELECTOR);
      if (menu) {
        injectExtraOptions(menu);
      }
    }

    // 监听 DOM 变化，在菜单出现时自动注入
    const menuObserver = new MutationObserver((mutations) => {
      // 只有当菜单变为可见时才注入
      const menu = document.querySelector(MENU_SELECTOR);
      if (menu && menu.style.display !== 'none' && getComputedStyle(menu).display !== 'none') {
        injectExtraOptions(menu);
      }
    });

    menuObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

    // 立即尝试一次
    tryPatchMenu();

    // 暴露全局接口
    window.__vssPlayerSpeedPatch = {
      setSpeed: setPlayerSpeed,
      getSpeed: () => state.currentSpeed,
      speeds: EXTRA_SPEEDS.map(s => s.value)
    };
  })();

  // ==================== 初始化 ====================

  // 页面加载时扫描视频
  scanVideos();

  // 监听 DOM 变化，自动检测新视频
  const observer = new MutationObserver(() => {
    scanVideos();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 恢复上次倍速设置
  chrome.storage.local.get(['vss_speed'], (result) => {
    if (result.vss_speed) {
      setSpeed(result.vss_speed);
    }
  });

  // 监听键盘快捷键
  document.addEventListener('keydown', (e) => {
    // 避免在输入框中触发
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    // Alt + > 加速
    if (e.altKey && e.key === '.') {
      e.preventDefault();
      adjustSpeed(0.25);
    }
    // Alt + < 减速
    if (e.altKey && e.key === ',') {
      e.preventDefault();
      adjustSpeed(-0.25);
    }
    // Alt + R 重置
    if (e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      setSpeed(1.0);
    }
    // Alt + P 播放/暂停
    if (e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      const video = state.videos[0];
      if (video) video.paused ? video.play() : video.pause();
    }
  });

  console.log('[VSS] 视频倍速同步助手已加载');
})();
