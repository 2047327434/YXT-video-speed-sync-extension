/**
 * content.js - 云学堂自动挂课助手
 *
 * 功能：自动播放视频、视频结束后自动切下一课、后台静默挂机、防检测
 */

(function () {
  'use strict';

  if (window.__yxtAutoStudyInjected) return;
  window.__yxtAutoStudyInjected = true;

  // ==================== 状态管理 ====================
  const state = {
    enabled: false,           // 是否开启自动挂机
    idleMode: true,           // 是否后台静默模式（静音）
    isRunning: false,         // 当前是否正在挂机流程中
    currentVideo: null,       // 当前控制的视频
    courseTotal: 0,           // 课程总数
    courseCurrent: 0,         // 当前课程序号
    lastAction: '等待中',      // 最后一次操作
    startTime: null,          // 挂机开始时间
    popupPort: null,          // 与 popup 的通信端口
    antiDetectTimer: null,    // 防检测定时器
    checkTimer: null,         // 主检测循环定时器
  };

  const STORAGE_KEY = 'yxt_auto_study_state';

  // ==================== DOM 选择器 ====================
  const SELECTORS = {
    video: 'video',
    nextBtn: 'button:has(.yxtf-icon-arrow-right), button span:contains("下一个")',
    // 云学堂课程列表项
    courseItem: '.task-content-item, .chapter-item, .course-item',
    // 弹窗关闭按钮
    dialogClose: '.yxtf-dialog__headerbtn, .yxt-dialog__headerbtn, .yxtf-icon-close',
    // 倒计时组件
    countdown: '.yxtulcdsdk-course-player__countdown',
    // 播放按钮（如果视频没自动播放）
    playBtn: '.jw-icon-playback, .yxt-biz-video-playbtn',
  };

  // ==================== 日志输出 ====================
  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const prefix = `[YXT挂机 ${time}]`;
    const fullMsg = `${prefix} ${msg}`;

    if (type === 'error') console.error(fullMsg);
    else if (type === 'warn') console.warn(fullMsg);
    else console.log(fullMsg);

    state.lastAction = msg;
    broadcastToPopup({ type: 'status', status: msg });
  }

  // ==================== 视频检测 ====================
  function findVideo() {
    const v = document.querySelector('video');
    if (v && v.readyState >= 1) {
      state.currentVideo = v;
      return v;
    }
    // 尝试在 iframe 中查找
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iv = iframe.contentDocument?.querySelector('video');
        if (iv) { state.currentVideo = iv; return iv; }
      } catch (e) {}
    }
    return null;
  }

  // ==================== 核心挂机逻辑 ====================

  /**
   * 保存状态到 storage（持久化）
   */
  function saveState() {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        enabled: state.enabled,
        idleMode: state.idleMode,
        startTime: state.startTime,
        courseCurrent: state.courseCurrent,
      }
    });
  }

  /**
   * 从 storage 恢复状态
   */
  async function restoreState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const saved = result[STORAGE_KEY];
        if (saved && saved.enabled) {
          state.enabled = saved.enabled;
          state.idleMode = saved.idleMode ?? true;
          state.courseCurrent = saved.courseCurrent ?? 0;
          // startTime 恢复为当前时间（避免页面刷新后计算运行时长出错）
          state.startTime = Date.now();
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * 启动挂机
   */
  function startAutoStudy() {
    if (state.isRunning) return;
    state.enabled = true;
    state.isRunning = true;
    state.startTime = Date.now();

    // 持久化状态
    saveState();

    log('🚀 自动挂机已启动');
    broadcastToPopup({ type: 'started', startTime: state.startTime });

    // 立即执行一次
    tick();

    // 每 2 秒检测一次状态
    state.checkTimer = setInterval(tick, 2000);

    // 启动防检测机制
    startAntiDetect();
  }

  /**
   * 停止挂机
   */
  function stopAutoStudy() {
    state.enabled = false;
    state.isRunning = false;

    // 清除持久化状态
    chrome.storage.local.remove(STORAGE_KEY);

    if (state.checkTimer) {
      clearInterval(state.checkTimer);
      state.checkTimer = null;
    }
    stopAntiDetect();

    // 恢复音量
    const video = findVideo();
    if (video) video.muted = false;

    log('⏹️ 自动挂机已停止');
    broadcastToPopup({ type: 'stopped' });
  }

  /**
   * 主检测循环
   */
  function tick() {
    if (!state.enabled) return;

    const video = findVideo();

    // 1. 没找到视频 → 可能在加载中，继续等待
    if (!video) {
      log('⏳ 等待视频加载...');
      return;
    }

    // 2. 绑定视频事件（只绑定一次）
    if (!video.dataset.yxtBound) {
      bindVideoEvents(video);
      video.dataset.yxtBound = 'true';
    }

    // 3. 后台模式：静音
    if (state.idleMode && !video.muted) {
      video.muted = true;
      log('🔇 已静音（后台模式）');
    }

    // 4. 如果视频暂停了，自动播放
    if (video.paused) {
      // 尝试直接 play
      const playPromise = video.play();
      if (playPromise) {
        playPromise.catch(() => {
          // 浏览器阻止自动播放，尝试点击播放按钮
          clickPlayButton();
        });
      }
      log('▶️ 视频已自动播放');
    }

    // 5. 更新进度到 popup
    broadcastToPopup({
      type: 'progress',
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      speed: video.playbackRate,
    });
  }

  /**
   * 绑定视频事件
   */
  function bindVideoEvents(video) {
    // 视频播放结束 → 自动下一课
    video.addEventListener('ended', () => {
      log('✅ 当前视频播放完毕，准备切换下一课');
      setTimeout(() => clickNextButton(), 2000);
    });

    // 视频进度接近结尾也触发（有些视频 ended 事件不可靠）
    video.addEventListener('timeupdate', () => {
      if (video.duration && video.currentTime >= video.duration - 3) {
        if (!video.dataset.yxtNearEnd) {
          video.dataset.yxtNearEnd = 'true';
          log('⏭️ 视频即将结束，准备切换下一课');
          setTimeout(() => clickNextButton(), 3000);
        }
      }
    });

    // 防止页面失焦时视频被暂停
    video.addEventListener('pause', () => {
      if (state.enabled && video.currentTime < video.duration - 1) {
        // 如果不是用户手动暂停（接近结尾），自动恢复播放
        setTimeout(() => {
          if (state.enabled && video.paused) {
            video.play().catch(() => {});
            log('🛡️ 检测到视频被暂停，已自动恢复');
          }
        }, 1000);
      }
    });
  }

  // ==================== 自动切课 ====================

  /**
   * 点击"下一个"按钮
   */
  function clickNextButton() {
    if (!state.enabled) return;

    // 尝试多种选择器定位"下一个"按钮
    const nextBtn =
      document.querySelector('button span .yxtf-icon-arrow-right')?.closest('button') ||
      document.querySelector('button:has(.yxtf-icon-arrow-right)') ||
      Array.from(document.querySelectorAll('button')).find(btn =>
        btn.textContent.includes('下一个')
      );

    if (nextBtn) {
      nextBtn.click();
      log('➡️ 已点击"下一个"');
      state.courseCurrent++;

      // 重置视频绑定标记
      if (state.currentVideo) {
        delete state.currentVideo.dataset.yxtBound;
        delete state.currentVideo.dataset.yxtNearEnd;
      }
      state.currentVideo = null;

      broadcastToPopup({ type: 'nextCourse', current: state.courseCurrent });
    } else {
      log('⚠️ 未找到"下一个"按钮，可能已是最后一课');
      broadcastToPopup({ type: 'finished', message: '所有课程已完成' });
      stopAutoStudy();
    }
  }

  /**
   * 点击播放按钮（处理浏览器自动播放限制）
   */
  function clickPlayButton() {
    const btn =
      document.querySelector('.jw-icon-playback') ||
      document.querySelector('.yxt-biz-video-playbtn') ||
      document.querySelector('.jw-display-icon-container');
    if (btn) {
      btn.click();
      log('🖱️ 已点击播放按钮');
    }
  }

  // ==================== 防检测机制 ====================

  /**
   * 启动防检测
   * 1. 页面失焦时保持视频播放
   * 2. 随机小暂停模拟真实用户
   * 3. 自动关闭弹窗
   */
  function startAntiDetect() {
    if (state.antiDetectTimer) return;

    // 失焦保活：覆盖 visibilitychange
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 随机暂停模拟
    state.antiDetectTimer = setInterval(() => {
      if (!state.enabled) return;

      // 每 30~60 秒随机暂停 1~3 秒，模拟真实用户偶尔离开
      const shouldPause = Math.random() < 0.05; // 5% 概率
      if (shouldPause) {
        const video = findVideo();
        if (video && !video.paused && video.currentTime < video.duration - 10) {
          video.pause();
          const pauseMs = 1000 + Math.random() * 2000;
          log(`🎭 模拟真实用户暂停 ${(pauseMs/1000).toFixed(1)} 秒`);
          setTimeout(() => {
            if (state.enabled && video.paused) {
              video.play().catch(() => {});
            }
          }, pauseMs);
        }
      }

      // 自动关闭弹窗
      closeDialogs();

    }, 10000);
  }

  function stopAntiDetect() {
    if (state.antiDetectTimer) {
      clearInterval(state.antiDetectTimer);
      state.antiDetectTimer = null;
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }

  /**
   * 页面失焦时保持播放
   */
  function handleVisibilityChange() {
    if (state.enabled && document.hidden) {
      const video = findVideo();
      if (video && video.paused) {
        video.play().catch(() => {});
        log('🛡️ 页面失焦，已保活视频播放');
      }
    }
  }

  /**
   * 自动关闭弹窗
   */
  function closeDialogs() {
    const closeBtns = document.querySelectorAll(
      '.yxtf-dialog__headerbtn, .yxt-dialog__headerbtn, .yxtf-icon-close, .yxtf-button--primary span:contains("确定")'
    );
    closeBtns.forEach(btn => {
      // 只关闭非关键弹窗（如提示、广告）
      const dialog = btn.closest('.yxtf-dialog, .yxt-dialog');
      if (dialog) {
        const title = dialog.querySelector('.yxtf-dialog__title, .yxt-dialog__title')?.textContent || '';
        // 不关闭考试、练习等关键弹窗
        if (!/考试|练习|测评|问卷|测试/.test(title)) {
          btn.click();
          log('❌ 已自动关闭弹窗');
        }
      }
    });
  }

  // ==================== 通信接口 ====================

  function broadcastToPopup(message) {
    chrome.runtime.sendMessage({ target: 'popup', ...message }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target !== 'content') return;

    switch (request.action) {
      case 'start':
        startAutoStudy();
        sendResponse({ success: true });
        break;

      case 'stop':
        stopAutoStudy();
        sendResponse({ success: true });
        break;

      case 'getStatus':
        const video = findVideo();
        sendResponse({
          enabled: state.enabled,
          isRunning: state.isRunning,
          lastAction: state.lastAction,
          startTime: state.startTime,
          idleMode: state.idleMode,
          video: video ? {
            currentTime: video.currentTime,
            duration: video.duration,
            paused: video.paused,
            speed: video.playbackRate,
          } : null,
        });
        break;

      case 'toggleIdleMode':
        state.idleMode = !state.idleMode;
        log(state.idleMode ? '🔇 已开启后台静默模式' : '🔊 已关闭后台静默模式');
        sendResponse({ success: true, idleMode: state.idleMode });
        break;

      case 'clickNext':
        clickNextButton();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: '未知操作' });
    }

    return true;
  });

  // ==================== 初始化 ====================

  // 页面加载时，先尝试从 storage 恢复挂机状态
  // 这样即使 popup 被关闭或页面刷新，挂机也能自动继续
  restoreState().then((wasRunning) => {
    if (wasRunning) {
      log('📦 云学堂自动挂课助手已加载，检测到之前有挂机任务，正在自动恢复...');
      startAutoStudy();
    } else {
      log('📦 云学堂自动挂课助手已加载，等待启动指令');
    }
  });
})();
