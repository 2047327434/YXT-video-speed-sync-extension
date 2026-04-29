/**
 * popup.js - 挂机控制面板
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM 元素
  const elStatusDot = document.getElementById('statusDot');
  const elStatusText = document.getElementById('statusText');
  const elStatusDetail = document.getElementById('statusDetail');
  const elBtnStart = document.getElementById('btnStart');
  const elBtnStop = document.getElementById('btnStop');
  const elChkIdleMode = document.getElementById('chkIdleMode');
  const elProgressFill = document.getElementById('progressFill');
  const elCurrentTime = document.getElementById('currentTime');
  const elDuration = document.getElementById('duration');
  const elProgressPercent = document.getElementById('progressPercent');
  const elStatRuntime = document.getElementById('statRuntime');
  const elStatCourses = document.getElementById('statCourses');
  const elStatStatus = document.getElementById('statStatus');

  let currentTabId = null;
  let startTime = null;
  let runtimeTimer = null;
  let courseCount = 0;

  const STORAGE_KEY = 'yxt_auto_study_state';

  // ==================== 初始化 ====================

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      currentTabId = tabs[0].id;
      // 先从 storage 读取状态，确保 popup 打开时立即显示正确状态
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const saved = result[STORAGE_KEY];
        if (saved && saved.enabled) {
          setRunningUI(true);
          startRuntimeTimer();
        }
        // 然后再向 content script 请求最新状态
        refreshStatus();
      });
    }
  });

  // ==================== 控制按钮 ====================

  elBtnStart.addEventListener('click', () => {
    sendToContent('start', {}, (response) => {
      if (response && response.success) {
        setRunningUI(true);
        startRuntimeTimer();
      }
    });
  });

  elBtnStop.addEventListener('click', () => {
    sendToContent('stop', {}, (response) => {
      if (response && response.success) {
        setRunningUI(false);
        stopRuntimeTimer();
      }
    });
  });

  elChkIdleMode.addEventListener('change', () => {
    sendToContent('toggleIdleMode');
  });

  document.getElementById('btnSkipNext').addEventListener('click', () => {
    sendToContent('clickNext');
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    refreshStatus();
  });

  // ==================== UI 更新 ====================

  function setRunningUI(running) {
    if (running) {
      elBtnStart.style.display = 'none';
      elBtnStop.style.display = 'flex';
      elStatusDot.className = 'status-dot running';
      elStatusText.textContent = '挂机中';
      elStatusText.style.color = '#48bb78';
      elStatusDetail.textContent = '后台自动刷课，请勿关闭标签页';
      elStatStatus.textContent = '挂机中';
    } else {
      elBtnStart.style.display = 'flex';
      elBtnStop.style.display = 'none';
      elStatusDot.className = 'status-dot stopped';
      elStatusText.textContent = '已停止';
      elStatusText.style.color = '#fc8181';
      elStatusDetail.textContent = '点击"开始挂机"自动刷课';
      elStatStatus.textContent = '已停止';
      elProgressFill.style.width = '0%';
      elProgressPercent.textContent = '0%';
    }
  }

  function updateVideoProgress(video) {
    if (!video) return;

    const pct = video.duration > 0
      ? Math.round((video.currentTime / video.duration) * 100)
      : 0;

    elProgressFill.style.width = pct + '%';
    elCurrentTime.textContent = formatTime(video.currentTime);
    elDuration.textContent = formatTime(video.duration);
    elProgressPercent.textContent = pct + '%';
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function formatRuntime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // ==================== 运行时长计时器 ====================

  function startRuntimeTimer() {
    startTime = Date.now();
    if (runtimeTimer) clearInterval(runtimeTimer);
    runtimeTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      elStatRuntime.textContent = formatRuntime(elapsed);
    }, 1000);
  }

  function stopRuntimeTimer() {
    if (runtimeTimer) {
      clearInterval(runtimeTimer);
      runtimeTimer = null;
    }
    startTime = null;
    elStatRuntime.textContent = '00:00';
  }

  // ==================== 通信 ====================

  function sendToContent(action, data = {}, callback) {
    if (!currentTabId) return;
    chrome.tabs.sendMessage(currentTabId, { target: 'content', action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('通信失败:', chrome.runtime.lastError.message);
        if (callback) callback(null);
        return;
      }
      if (callback) callback(response);
    });
  }

  function refreshStatus() {
    sendToContent('getStatus', {}, (response) => {
      if (!response) return;

      setRunningUI(response.isRunning);

      if (response.video) {
        updateVideoProgress(response.video);
      }

      if (response.isRunning && !runtimeTimer) {
        startRuntimeTimer();
      } else if (!response.isRunning && runtimeTimer) {
        stopRuntimeTimer();
      }

      if (response.idleMode !== undefined) {
        elChkIdleMode.checked = response.idleMode;
      }
    });
  }

  // 监听来自 content 的消息
  chrome.runtime.onMessage.addListener((message) => {
    if (message.target !== 'popup') return;

    switch (message.type) {
      case 'status':
        elStatStatus.textContent = message.status;
        break;
      case 'progress':
        updateVideoProgress(message);
        break;
      case 'nextCourse':
        courseCount++;
        elStatCourses.textContent = courseCount;
        break;
      case 'finished':
        setRunningUI(false);
        stopRuntimeTimer();
        elStatusDetail.textContent = message.message;
        break;
    }
  });

  // 定时刷新状态
  setInterval(refreshStatus, 3000);
});
