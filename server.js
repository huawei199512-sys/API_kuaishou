const express = require('express');
const cors = require('cors');
const scraper = require('./scraper');
const proxyManager = require('./proxyManager');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// ============ 全局错误防护 ============
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err && err.message ? err.message : err);
});

// ============ 健康检查 ============
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============ 首页 ============
app.get('/', (req, res) => {
  res.json({
    service: 'Kuaishou Video API',
    version: '1.0.0',
    data_version: '1.1',
    description: '快手视频搜索/详情/评论API - GraphQL + 代理IP',
    mode: '代理IP + GraphQL',
    features: {
      cookie_required: false,
      proxy_mode: '纯代理模式（强制，不回退直连）',
      proxy_pool: '13源自动刷新代理池（每30分钟）',
      api_source: 'www.kuaishou.com GraphQL',
    },
    endpoints: {
      search: 'GET /api/search?keyword=泰山&pcursor=&page=search',
      detail: 'GET /api/detail/:photoId',
      comments: 'GET /api/comments/:photoId?pcursor=',
      proxy_status: 'GET /api/proxy/status',
    },
    proxy_status: proxyManager.getStatus(),
  });
});

// ============ 1. 关键词搜索视频 ============
app.get('/api/search', async (req, res) => {
  try {
    const { keyword, pcursor = '', page = 'search' } = req.query;
    if (!keyword) {
      return res.status(400).json({ success: false, error: 'keyword参数必填' });
    }
    proxyManager.setEnabled(true);
    const result = await scraper.searchVideos(keyword, pcursor, page);
    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 2. 视频详情 ============
app.get('/api/detail/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    if (!photoId) {
      return res.status(400).json({ success: false, error: 'photoId参数必填' });
    }
    proxyManager.setEnabled(true);
    const result = await scraper.getVideoDetail(photoId);
    res.json(result);
  } catch (error) {
    console.error('Detail error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 3. 视频评论 ============
app.get('/api/comments/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { pcursor = '' } = req.query;
    if (!photoId) {
      return res.status(400).json({ success: false, error: 'photoId参数必填' });
    }
    proxyManager.setEnabled(true);
    const result = await scraper.getVideoComments(photoId, pcursor);
    res.json(result);
  } catch (error) {
    console.error('Comments error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 代理状态 ============
app.get('/api/proxy/status', (req, res) => {
  res.json({ success: true, data: proxyManager.getStatus() });
});

// ============ 手动刷新代理池 ============
app.post('/api/proxy/refresh', async (req, res) => {
  try {
    await proxyManager.refreshProxies(false);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ 启动服务 ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  Kuaishou Video API 服务已启动');
  console.log(`  端口: ${PORT}`);
  console.log('  模式: 代理IP + GraphQL（无需Cookie）');
  console.log('  接口:');
  console.log('    GET /api/search?keyword=关键词');
  console.log('    GET /api/detail/:photoId');
  console.log('    GET /api/comments/:photoId?pcursor=');
  console.log('  代理池: 13源自动刷新（每30分钟）');
  console.log('============================================');

  // 后台初始化代理池
  setTimeout(async () => {
    try {
      console.log('[启动] 后台初始化代理池...');
      await proxyManager.refreshProxies(true);
      proxyManager.startAutoRefresh(30);
      console.log('[启动] 代理池初始化完成');
    } catch (e) {
      console.warn('[启动] 代理池初始化失败:', e.message);
      proxyManager.startAutoRefresh(30);
    }
  }, 1000);
});