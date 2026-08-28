// 设置环境变量忽略自签名证书（免费代理常见问题）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 快手公开数据爬虫 - GraphQL API + 代理IP + curl-cffi指纹
// 采集站点已公开数据，无需登录，robots允许
// 关键词搜索: visionSearchPhoto
// 视频详情: visionVideoDetail
// 视频评论: commentListQuery
const axios = require('axios');
const https = require('https');
const proxyManager = require('./proxyManager');

// 使用curl-cffi模拟真实浏览器TLS指纹（快手反爬必需）
let CurlCffi = null;
try { CurlCffi = require('curl-cffi'); } catch { CurlCffi = null; }
console.log('[Kuaishou] curl-cffi:', CurlCffi ? '可用' : '未安装（降级使用axios，可能触发验证码）');

// ============ GraphQL配置 ============
const GRAPHQL_URL = 'https://www.kuaishou.com/graphql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 快手GraphQL必需的Cookie（从公开项目中提取，无需登录）
const DEFAULT_COOKIE = [
  'kpf=PC_WEB',
  'kpn=KUAISHOU_VISION',
  'clientid=3',
  'did=web_d5468278a1e92934b3751f249005ffd3',
  'client_key=65890b29',
].join('; ');

// 超时与并发策略（适配Render免费版30秒限制）
const SINGLE_PROXY_TIMEOUT = 14000;
const TOTAL_REQUEST_TIMEOUT = 25000;
const CONCURRENT_PROXIES = 2;
const MAX_ROUNDS = 2;

// 自定义HTTPS Agent（axios降级方案使用）
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  rejectUnauthorized: false,
});

// ============ GraphQL查询语句 ============

// 关键词搜索 - 返回视频列表(含标题/播放量/点赞/封面/作者等)
const SEARCH_QUERY = `
fragment photoContent on PhotoEntity {
  __typename
  id
  duration
  caption
  originCaption
  likeCount
  viewCount
  commentCount
  realLikeCount
  coverUrl
  photoUrl
  photoH265Url
  manifest
  manifestH265
  videoResource
  coverUrls { url __typename }
  timestamp
  expTag
  animatedCoverUrl
  distance
  videoRatio
  liked
  stereoType
  profileUserTopPhoto
  musicBlocked
}
fragment recoPhotoFragment on recoPhotoEntity {
  __typename
  id
  duration
  caption
  originCaption
  likeCount
  viewCount
  commentCount
  realLikeCount
  coverUrl
  photoUrl
  photoH265Url
  manifest
  manifestH265
  videoResource
  coverUrls { url __typename }
  timestamp
  expTag
  animatedCoverUrl
  distance
  videoRatio
  liked
  stereoType
  profileUserTopPhoto
  musicBlocked
}
fragment feedContent on Feed {
  type
  author {
    id
    name
    headerUrl
    following
    headerUrls { url __typename }
    __typename
  }
  photo {
    ...photoContent
    ...recoPhotoFragment
    __typename
  }
  canAddComment
  llsid
  status
  currentPcursor
  tags { type name __typename }
  __typename
}
query visionSearchPhoto($keyword: String, $pcursor: String, $searchSessionId: String, $page: String, $webPageArea: String) {
  visionSearchPhoto(keyword: $keyword, pcursor: $pcursor, searchSessionId: $searchSessionId, page: $page, webPageArea: $webPageArea) {
    result
    llsid
    webPageArea
    feeds { ...feedContent __typename }
    searchSessionId
    pcursor
    aladdinBanner { imgUrl link __typename }
    __typename
  }
}
`;

// 视频详情 - 返回完整视频信息(含manifest/清晰度/作者等)
const VIDEO_DETAIL_QUERY = `
query visionVideoDetail($photoId: String, $type: String, $page: String, $webPageArea: String) {
  visionVideoDetail(photoId: $photoId, type: $type, page: $page, webPageArea: $webPageArea) {
    status
    type
    author {
      id
      name
      following
      headerUrl
      __typename
    }
    photo {
      id
      duration
      caption
      likeCount
      realLikeCount
      coverUrl
      photoUrl
      liked
      timestamp
      expTag
      llsid
      viewCount
      videoRatio
      stereoType
      musicBlocked
      manifest {
        mediaType
        businessType
        version
        adaptationSet {
          id
          duration
          representation {
            id
            defaultSelect
            backupUrl
            codecs
            url
            height
            width
            avgBitrate
            maxBitrate
            m3u8Slice
            qualityType
            qualityLabel
            frameRate
            featureP2sp
            hidden
            disableAdaptive
            __typename
          }
          __typename
        }
        __typename
      }
      manifestH265
      photoH265Url
      coronaCropManifest
      coronaCropManifestH265
      croppedPhotoH265Url
      croppedPhotoUrl
      videoResource
      __typename
    }
    tags { type name __typename }
    commentLimit { canAddComment __typename }
    llsid
    danmakuSwitch
    __typename
  }
}
`;

// 视频评论 - 返回评论列表(含子评论/翻页)
const COMMENT_LIST_QUERY = `
query commentListQuery($photoId: String, $pcursor: String) {
  visionCommentList(photoId: $photoId, pcursor: $pcursor) {
    commentCount
    pcursor
    rootComments {
      commentId
      authorId
      authorName
      content
      headurl
      timestamp
      likedCount
      realLikedCount
      liked
      status
      authorLiked
      subCommentCount
      subCommentsPcursor
      subComments {
        commentId
        authorId
        authorName
        content
        headurl
        timestamp
        likedCount
        realLikedCount
        liked
        status
        authorLiked
        replyToUserName
        replyTo
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

// ============ 代理竞态请求 ============
async function requestWithProxyRace(requestFn, options = {}) {
  const { concurrentProxies = CONCURRENT_PROXIES, maxRounds = MAX_ROUNDS, totalTimeout = TOTAL_REQUEST_TIMEOUT } = options;
  if (!proxyManager.isEnabled()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), totalTimeout);
    try { return await requestFn(null, controller.signal); }
    finally { clearTimeout(timer); }
  }
  const allProxies = proxyManager.proxies.length > 0 ? proxyManager.proxies : [];
  const usedProxies = new Set();
  let lastError = null;
  for (let round = 0; round < maxRounds; round++) {
    const available = [];
    for (const p of allProxies) {
      if (!usedProxies.has(p) && !proxyManager.badProxies.has(p)) available.push(p);
    }
    if (available.length === 0) {
      usedProxies.clear();
      continue;
    }
    const batch = available.slice(0, concurrentProxies);
    const controller = new AbortController();
    const roundTimeout = Math.max(SINGLE_PROXY_TIMEOUT, totalTimeout / maxRounds);
    const timer = setTimeout(() => controller.abort(), roundTimeout);
    try {
      const results = await Promise.allSettled(
        batch.map(async (proxy) => {
          try {
            const result = await requestFn(proxy, controller.signal);
            if (result.success) {
              proxyManager.markSuccess(proxy);
              usedProxies.add(proxy);
              return result;
            }
            proxyManager.markFailed(proxy);
            usedProxies.add(proxy);
            lastError = result.error || '请求失败';
            return null;
          } catch (err) {
            proxyManager.markFailed(proxy);
            usedProxies.add(proxy);
            lastError = err.message || '代理异常';
            return null;
          }
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value && r.value.success) {
          return r.value;
        }
      }
    } finally { clearTimeout(timer); }
  }
  return { success: false, error: lastError || '所有代理都失败了' };
}

// ============ GraphQL请求（优先使用curl-cffi模拟浏览器指纹）============
async function graphqlRequest(operationName, variables, proxy = null, abortSignal = null) {
  const payload = {
    operationName,
    variables,
    query: operationName === 'visionSearchPhoto' ? SEARCH_QUERY :
           operationName === 'visionVideoDetail' ? VIDEO_DETAIL_QUERY :
           operationName === 'commentListQuery' ? COMMENT_LIST_QUERY : '',
  };

  const headers = {
    'User-Agent': UA,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': 'https://www.kuaishou.com',
    'Referer': 'https://www.kuaishou.com/',
    'Cookie': DEFAULT_COOKIE,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };

  // 优先使用curl-cffi（模拟真实浏览器TLS指纹，绕过字节系反爬）
  if (CurlCffi) {
    try {
      const fetchOptions = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: SINGLE_PROXY_TIMEOUT,
        impersonate: 'chrome120',
      };
      if (proxy) {
        // curl-cffi的proxy需要完整URL格式，给HTTP代理添加http://前缀
        let proxyUrl = proxy;
        if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://') && !proxyUrl.startsWith('socks')) {
          proxyUrl = 'http://' + proxyUrl;
        }
        fetchOptions.proxy = proxyUrl;
      }
      const resp = await CurlCffi.fetch(GRAPHQL_URL, fetchOptions);
      if (resp.status !== 200) {
        return { success: false, error: `HTTP ${resp.status}` };
      }
      let data;
      if (typeof resp.data === 'string') {
        try {
          data = JSON.parse(resp.data);
        } catch {
          data = resp.data;
        }
      } else {
        data = resp.data;
      }
      // 检查是否触发了验证码（result为400002表示风控）
      if (data && data.data && data.data.result === 400002) {
        return { success: false, error: '触发风控验证码，换代理重试' };
      }
      if (data && data.errors) {
        return { success: false, error: data.errors[0]?.message || 'GraphQL错误' };
      }
      if (!data || !data.data) {
        return { success: false, error: '响应数据为空' };
      }
      return { success: true, data: data.data };
    } catch (error) {
      console.log(`[Kuaishou] curl-cffi失败(${error.message}), 降级到axios`);
    }
  }

  // 降级方案：使用axios（不带浏览器指纹，成功率较低）
  try {
    const axiosConfig = {
      method: 'POST',
      url: GRAPHQL_URL,
      data: payload,
      headers,
      timeout: SINGLE_PROXY_TIMEOUT,
      signal: abortSignal,
      maxRedirects: 3,
      validateStatus: () => true,
      decompress: true,
      httpsAgent: httpsAgent,
    };
    if (proxy) {
      const agent = proxyManager.createAgent(proxy);
      if (agent) {
        axiosConfig.httpsAgent = agent;
        axiosConfig.httpAgent = agent;
      }
    }
    const resp = await axios(axiosConfig);
    if (resp.status !== 200) {
      return { success: false, error: `HTTP ${resp.status}` };
    }
    const data = resp.data;
    // 检查是否触发了验证码
    if (data && data.data && data.data.result === 400002) {
      return { success: false, error: '触发风控验证码，换代理重试' };
    }
    if (data && data.errors) {
      return { success: false, error: data.errors[0]?.message || 'GraphQL错误' };
    }
    if (!data || !data.data) {
      return { success: false, error: '响应数据为空' };
    }
    return { success: true, data: data.data };
  } catch (error) {
    const isTimeout = error.name === 'CanceledError' || error.name === 'AbortError' ||
      error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ERR_CANCELED' ||
      error.message?.includes('timeout') || error.message?.includes('Timeout');
    return { success: false, error: isTimeout ? '请求超时' : error.message };
  }
}

// ============ 1. 关键词搜索视频 ============
async function searchVideos(keyword, pcursor = '', page = 'search') {
  console.log(`[Kuaishou] 搜索视频: ${keyword}, pcursor: ${pcursor}`);
  const result = await requestWithProxyRace(async (proxy, signal) => {
    const resp = await graphqlRequest('visionSearchPhoto', {
      keyword,
      pcursor,
      page,
    }, proxy, signal);
    if (!resp.success) return resp;
    const searchData = resp.data?.visionSearchPhoto;
    if (!searchData) return { success: false, error: '搜索结果为空' };
    const feeds = searchData.feeds || [];
    const videos = feeds.map(feed => {
      const photo = feed?.photo || {};
      const author = feed?.author || {};
      const tags = feed?.tags || [];
      return {
        type: feed.type || '',
        photo_id: photo.id || '',
        caption: photo.caption || '',
        origin_caption: photo.originCaption || '',
        duration: photo.duration || 0,
        like_count: photo.likeCount || 0,
        view_count: photo.viewCount || 0,
        comment_count: photo.commentCount || 0,
        real_like_count: photo.realLikeCount || 0,
        cover_url: photo.coverUrl || '',
        photo_url: photo.photoUrl || '',
        photo_h265_url: photo.photoH265Url || '',
        animated_cover_url: photo.animatedCoverUrl || '',
        video_ratio: photo.videoRatio || 0,
        timestamp: photo.timestamp || 0,
        liked: photo.liked || false,
        stereo_type: photo.stereoType || 0,
        music_blocked: photo.musicBlocked || false,
        exp_tag: photo.expTag || '',
        distance: photo.distance || 0,
        author: {
          id: author.id || '',
          name: author.name || '',
          header_url: author.headerUrl || '',
          following: author.following || false,
        },
        tags: tags.map(t => ({ type: t.type, name: t.name })),
        can_add_comment: feed.canAddComment || false,
        status: feed.status || 0,
        llsid: feed.llsid || '',
        current_pcursor: feed.currentPcursor || '',
      };
    });
    return {
      success: true,
      data: {
        keyword,
        result: searchData.result || 0,
        pcursor: searchData.pcursor || '',
        search_session_id: searchData.searchSessionId || '',
        llsid: searchData.llsid || '',
        web_page_area: searchData.webPageArea || '',
        videos,
        total: videos.length,
      },
    };
  });
  return result;
}

// ============ 2. 视频详情 ============
async function getVideoDetail(photoId) {
  console.log(`[Kuaishou] 获取视频详情: ${photoId}`);
  const result = await requestWithProxyRace(async (proxy, signal) => {
    const resp = await graphqlRequest('visionVideoDetail', {
      photoId,
      page: 'detail',
    }, proxy, signal);
    if (!resp.success) return resp;
    const detailData = resp.data?.visionVideoDetail;
    if (!detailData) return { success: false, error: '视频详情为空' };
    const photo = detailData.photo || {};
    const author = detailData.author || {};
    const tags = detailData.tags || [];
    const manifest = photo.manifest || {};
    const adaptationSets = manifest.adaptationSet || [];
    const representations = [];
    for (const set of adaptationSets) {
      for (const rep of (set.representation || [])) {
        representations.push({
          id: rep.id || '',
          url: rep.url || '',
          backup_url: rep.backupUrl || '',
          height: rep.height || 0,
          width: rep.width || 0,
          avg_bitrate: rep.avgBitrate || 0,
          max_bitrate: rep.maxBitrate || 0,
          quality_type: rep.qualityType || 0,
          quality_label: rep.qualityLabel || '',
          frame_rate: rep.frameRate || 0,
          codecs: rep.codecs || '',
          m3u8_slice: rep.m3u8Slice || false,
          default_select: rep.defaultSelect || false,
          feature_p2sp: rep.featureP2sp || false,
          hidden: rep.hidden || false,
          disable_adaptive: rep.disableAdaptive || false,
        });
      }
    }
    return {
      success: true,
      data: {
        status: detailData.status || 0,
        type: detailData.type || '',
        photo: {
          id: photo.id || '',
          caption: photo.caption || '',
          duration: photo.duration || 0,
          like_count: photo.likeCount || 0,
          real_like_count: photo.realLikeCount || 0,
          view_count: photo.viewCount || 0,
          cover_url: photo.coverUrl || '',
          photo_url: photo.photoUrl || '',
          photo_h265_url: photo.photoH265Url || '',
          cropped_photo_url: photo.croppedPhotoUrl || '',
          cropped_photo_h265_url: photo.croppedPhotoH265Url || '',
          video_resource: photo.videoResource || '',
          timestamp: photo.timestamp || 0,
          liked: photo.liked || false,
          video_ratio: photo.videoRatio || 0,
          stereo_type: photo.stereoType || 0,
          music_blocked: photo.musicBlocked || false,
          exp_tag: photo.expTag || '',
          llsid: photo.llsid || '',
          manifest: {
            media_type: manifest.mediaType || '',
            business_type: manifest.businessType || '',
            version: manifest.version || '',
            representations,
          },
          manifest_h265: photo.manifestH265 || '',
          corona_crop_manifest: photo.coronaCropManifest || '',
          corona_crop_manifest_h265: photo.coronaCropManifestH265 || '',
        },
        author: {
          id: author.id || '',
          name: author.name || '',
          header_url: author.headerUrl || '',
          following: author.following || false,
        },
        tags: tags.map(t => ({ type: t.type, name: t.name })),
        comment_limit: {
          can_add_comment: detailData.commentLimit?.canAddComment || false,
        },
        llsid: detailData.llsid || '',
        danmaku_switch: detailData.danmakuSwitch || false,
      },
    };
  });
  return result;
}

// ============ 3. 视频评论 ============
async function getVideoComments(photoId, pcursor = '') {
  console.log(`[Kuaishou] 获取视频评论: ${photoId}, pcursor: ${pcursor}`);
  const result = await requestWithProxyRace(async (proxy, signal) => {
    const resp = await graphqlRequest('commentListQuery', {
      photoId,
      pcursor,
    }, proxy, signal);
    if (!resp.success) return resp;
    const commentData = resp.data?.visionCommentList;
    if (!commentData) return { success: false, error: '评论列表为空' };
    const rootComments = commentData.rootComments || [];
    const comments = rootComments.map(comment => ({
      comment_id: comment.commentId || '',
      author_id: comment.authorId || '',
      author_name: comment.authorName || '',
      content: comment.content || '',
      head_url: comment.headurl || '',
      timestamp: comment.timestamp || 0,
      liked_count: comment.likedCount || 0,
      real_liked_count: comment.realLikedCount || 0,
      liked: comment.liked || false,
      status: comment.status || 0,
      author_liked: comment.authorLiked || false,
      sub_comment_count: comment.subCommentCount || 0,
      sub_comments_pcursor: comment.subCommentsPcursor || '',
      sub_comments: (comment.subComments || []).map(sub => ({
        comment_id: sub.commentId || '',
        author_id: sub.authorId || '',
        author_name: sub.authorName || '',
        content: sub.content || '',
        head_url: sub.headurl || '',
        timestamp: sub.timestamp || 0,
        liked_count: sub.likedCount || 0,
        real_liked_count: sub.realLikedCount || 0,
        liked: sub.liked || false,
        status: sub.status || 0,
        author_liked: sub.authorLiked || false,
        reply_to_user_name: sub.replyToUserName || '',
        reply_to: sub.replyTo || '',
      })),
    }));
    return {
      success: true,
      data: {
        photo_id: photoId,
        comment_count: commentData.commentCount || 0,
        pcursor: commentData.pcursor || '',
        comments,
        total: comments.length,
      },
    };
  });
  return result;
}

// ============ 导出 ============
module.exports = {
  searchVideos,
  getVideoDetail,
  getVideoComments,
  getProxyStatus: () => proxyManager.getStatus(),
  setProxyEnabled: (enabled) => {
    proxyManager.setEnabled(enabled);
    return proxyManager.getStatus();
  },
  refreshProxies: async () => {
    const proxies = await proxyManager.refreshProxies(true);
    return { ...proxyManager.getStatus(), proxies_count: proxies.length };
  },
};