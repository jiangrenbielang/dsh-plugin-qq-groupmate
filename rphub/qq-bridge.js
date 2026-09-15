/*!
 * qq-bridge.js —— 注入到生图页面里的桥接。
 *
 * 职责边界（重要）：
 *   本脚本**不实现生图接口**。它只做两件事：
 *     1. 把插件下发的设置写进网页自己的 settings（生图 token / 模型 / 画师 / 尺寸）；
 *     2. 从网页自己生成的「NAI画图正则」replacement 里读出**网页自己拼好的生图 URL 模板**，
 *        按它发请求（与 app.js 的 startGeneratedImageTask 同一套三步：提交 → 轮询 → 拿地址）。
 *   模型、画师串、尺寸、负面词、sampler、nocache 全部来自网页那份模板，换版本自动跟着变。
 *
 * 对外只暴露 window.__qqGen(tags, options) → Promise<{ imageUrl, job }>，
 * 图片本身由插件侧下载落盘（浏览器网络栈在这台机器上不可靠，下载不走浏览器）。
 */
(() => {
  if (window.__qqBridgeLoaded) return;
  window.__qqBridgeLoaded = true;

  const log = (...args) => {
    const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    console.log('[qq-bridge]', text);
    return text;
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 生图页面是 Vue 3 应用。注意：线上加载的是 vue.global.prod.js，
  // 生产构建不挂 app._instance（dev 专有），只能从挂载容器的 _vnode.component 取根实例。
  const appProxy = () => {
    const root = document.querySelector('#app');
    if (!root) return null;
    const app = root.__vue_app__;
    const instance = app?._instance || root._vnode?.component || app?._container?._vnode?.component;
    return instance?.proxy || null;
  };

  const waitForApp = async (timeoutMs = 90000) => {
    const startedAt = Date.now();
    let probe = '';
    while (Date.now() - startedAt < timeoutMs) {
      const proxy = appProxy();
      if (proxy?.settings && proxy?.regexScripts) return proxy;
      const root = document.querySelector('#app');
      probe = `root=${!!root} vueApp=${!!root?.__vue_app__} vnode=${!!root?._vnode} ` +
        `Vue=${typeof window.Vue} proxy=${!!proxy} settings=${!!proxy?.settings}`;
      await sleep(500);
    }
    throw new Error(`等待生图页面应用就绪超时（${probe}）`);
  };

  const readTemplate = (proxy) => {
    const script = (proxy.regexScripts || []).find(item => item?.name === 'NAI画图正则');
    const matched = /data-image-request="([^"]*)"/.exec(script?.replacement || '');
    return matched ? matched[1].replace(/&amp;/g, '&') : '';
  };

  /** 把模板 URL 里的关键字段解出来（token / model / size / artist）。 */
  const templateParams = (template) => {
    const out = { token: '', model: '', size: '', artist: '' };
    if (!template) return out;
    for (const key of ['token', 'model', 'size', 'artist']) {
      const matched = new RegExp(`[?&]${key}=([^&]*)`).exec(template);
      out[key] = matched ? decodeURIComponent(matched[1]) : '';
    }
    return out;
  };

  /**
   * 模板有没有反映出这份配置。
   *
   * 只查 token 是不够的（2026-09-14 实测踩到）：页面是「设置变了才重建模板」，
   * 而重建是异步的。冷启动时 token 往往已经落定（上一轮存过），于是只等 token 的话
   * 会**立刻**返回那份还是旧画师/旧尺寸的模板 —— 表现就是「换了画师，第一张图却还是老样子」。
   * 所以 token / model / size / artist 全都要对上才算就绪。
   *
   * 画师也要校验：applyConfig 现在总是显式写 imageStyle/customImageArtists，
   * 所以模板里的 artist 必须等于配置的画师串（没配就是空串）。
   * 这一条能挡住「页面留着上一次的画师串」——不然换了画师甚至清了画师都不生效。
   */
  const matchesConfig = (template, config) => {
    if (!template) return false;
    const params = templateParams(template);
    if (config.token && params.token !== config.token) return false;
    if (config.model && params.model !== config.model) return false;
    if (config.size && params.size !== config.size) return false;
    if (params.artist !== (config.customArtists || '')) return false;
    return true;
  };

  /**
   * 等模板反映出配置（token + 模型 + 尺寸 + 画师串都落定）。
   * 超时返回最后读到的模板，由调用方决定要不要报错。
   */
  const waitForTemplate = async (proxy, config, timeoutMs = 20000) => {
    const startedAt = Date.now();
    let template = '';
    while (Date.now() - startedAt < timeoutMs) {
      template = readTemplate(proxy);
      if (matchesConfig(template, config)) return template;
      await sleep(250);
    }
    return template;
  };

  /**
   * 先给页面一个短窗口（够它把刚写进去的设置反映到模板上），超了才动手强制重建。
   * 窗口不宜长：正常情况页面在同一次事件循环里就重建完了（applyConfig 还已经先等过 400ms），
   * 而这个窗口的长度就是「坏状态下的额外等待」——线上实测模板不一致时旧代码要白等 20 秒×2 才中止。
   */
  const QUICK_WAIT_MS = 800;

  /**
   * 逼页面重建一次生图模板。
   *
   * 为什么需要它（2026-09-14 晚实测）：页面只在 settings 里
   * imageStyle / customImageArtists / imageModel / imageSize **真的变了**时才重写模板
   * （app.js 的 updateImageGenRegexState 挂在那几个 watch 上），而 Vue 的 watch 对
   * 「值没变」是不回调的。可是页面里的 settings 与模板（regexScripts）是**分开持久化**的，
   * 浏览器 profile 被闲置回收、重启之后，两者很容易停在不一致的状态：
   * 实测到的一次是 settings.customImageArtists 已经是空串、模板里却还留着
   * `artist=…artist:ameto_yuki`（某个群友用过的画师预设）。
   * 这时候插件再写一遍配置也是**原来的值**，一个 watch 都不触发，模板就永远不更新——
   * 于是四个字段校验永远不通过 → 每次都在等待 20 秒后中止 → 退回直连慢路（实测 53~333 秒）。
   *
   * 做法：把 imageStyle 先写成一个临时值（触发一次重建），等它落定，再写回目标值
   * （再触发一次）。最终那次重建读的就是当前这份完整配置（画师串/模型/尺寸一起），
   * 所以模板必然跟上。代价约 0.7 秒，只在「模板已经不一致」时才走。
   */
  const forceTemplateRebuild = async (proxy, config) => {
    const settings = proxy.settings;
    const target = config.style || 'custom';
    const temporary = target === 'vertical' ? 'comicDoujin' : 'vertical';
    settings.imageStyle = temporary;
    proxy.saveData?.();
    await sleep(350);
    settings.imageStyle = target;
    proxy.saveData?.();
    await sleep(350);
  };

  /**
   * 拿一份与配置一致的模板：先等（短窗口），等不到就强制重建一次再等（长窗口）。
   * 仍不一致就把最后读到的模板交回调用方，由它决定中止与否——宁可慢也不能画错。
   */
  const templateMatchingConfig = async (proxy, config) => {
    let template = await waitForTemplate(proxy, config, QUICK_WAIT_MS);
    if (matchesConfig(template, config)) return template;
    log('模板与配置不一致，强制页面重建一次', templateParams(template).artist.slice(0, 30) || '(空)');
    await forceTemplateRebuild(proxy, config);
    template = await waitForTemplate(proxy, config);
    return template;
  };

  /**
   * 把插件配置写进页面 settings。
   *
   * 画风与画师串**必须显式写**（哪怕是空）：浏览器的 profile 会持久化页面 settings，
   * 只写不清的话，插件配置里没有画师时页面还留着上一次的画师串——
   * 表现就是「有人用 -p aka_kan 画过之后，下个没点画风的人继续吃到 aka_kan」。
   * 所以统一走 imageStyle=custom + customImageArtists=<画师串或空>：
   * 空串时模板里 artist= 为空，服务端用自己的默认画师。
   */
  const applyConfig = async (proxy, config) => {
    const settings = proxy.settings;
    const wanted = {
      imageGenKey: config.token,
      imageModel: config.model,
      imageSize: config.size,
      imageStyle: config.style || 'custom',
      customImageArtists: config.customArtists || ''
    };
    let changed = false;
    for (const [key, value] of Object.entries(wanted)) {
      if (value === undefined || value === null) continue;
      if (settings[key] !== value) { settings[key] = value; changed = true; }
    }
    if (changed) {
      // settings.imageGenKey 上有 watch，会重建「NAI画图正则」那份 URL 模板。
      proxy.saveData?.();
      await sleep(400);
    }
    return changed;
  };

  // 与 app.js startGeneratedImageTask 同一套三步。
  const submitAndPoll = async (requestUrl) => {
    const url = new URL(requestUrl, location.href);
    const params = Object.fromEntries(url.searchParams.entries());
    const baseUrl = url.origin;

    let job = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    }).then(response => response.json());

    if (!job?.id) throw new Error(job?.error || '任务提交失败');
    log('任务已提交', job.id, '状态', job.status);

    let failures = 0;
    let reported = '';
    while (!['done', 'failed'].includes(job.status)) {
      await sleep(1000);
      try {
        job = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(job.id)}?token=${encodeURIComponent(params.token)}`)
          .then(response => response.json());
        failures = 0;
      } catch (error) {
        if (++failures >= 5) throw error;
        continue;
      }
      const state = `${job.status}:${Math.round(Number(job.generationProgress?.percent || 0))}`;
      if (state !== reported) { reported = state; log('生成中', state); }
    }
    if (job.status !== 'done') throw new Error(job.error || '生成失败');

    const imageUrl = job.imageUrl
      ? new URL(job.imageUrl, baseUrl).href
      : `${baseUrl}/api/jobs/${encodeURIComponent(job.id)}/content?token=${encodeURIComponent(params.token)}`;
    return { job, imageUrl, baseUrl };
  };

  const ready = (async () => {
    const proxy = await waitForApp();
    const config = window.__qqConfig || {};
    await applyConfig(proxy, config);
    // 等模板把这份配置整个吃进去（token / 模型 / 尺寸 / 画师串都要落定）；
    // 页面 settings 与模板不同步时（见 forceTemplateRebuild 的说明）这里会自救一次。
    const template = await templateMatchingConfig(proxy, config);
    log('桥接就绪', template ? '模板已找到' : '模板缺失',
      matchesConfig(template, config) ? '（配置已写入）' : '（配置还没落定）');
    return { proxy, template };
  })();

  // 插件通过 CDP 调用这个。
  window.__qqGen = async (tags, options = {}) => {
    const { proxy, template: initial } = await ready;
    // 上一次 ready 之后配置可能又变过（换了画师/尺寸）：再等一次；仍不一致就再自救一次，
    // 还是不行才中止。别拿旧模板去画——那会「换了画师还是老画风」，而且白扣点。
    const config = window.__qqConfig || {};
    let template = await waitForTemplate(proxy, config) || initial;
    if (!template) throw new Error('网页里没有「NAI画图正则」模板（生图 Key 是否已写入？）');
    if (!matchesConfig(template, config)) {
      log('生成前模板仍与配置不一致，强制页面重建一次');
      await forceTemplateRebuild(proxy, config);
      template = await waitForTemplate(proxy, config) || template;
    }
    if (!matchesConfig(template, config)) {
      const got = templateParams(template);
      throw new Error(
        `网页模板没跟上最新设置（画师/尺寸/模型），已中止以免画错：` +
        `期望 artist=${(config.customArtists || '（页面自带画风）').slice(0, 40)} / ` +
        `model=${config.model || ''} / size=${config.size || ''}，` +
        `实际 artist=${got.artist.slice(0, 40)} / model=${got.model} / size=${got.size}`,
      );
    }

    // options.tags 覆盖（插件传入），模板里的 $1 就是标签位。
    // 用函数替换：标签里若出现 $&、$1 这类串，字符串替换会被二次展开。
    let requestUrl = template.replace('$1', () => tags);
    if (options.fresh) requestUrl = requestUrl.replace(/([?&])nocache=\d+/, '$1nocache=1');
    // 固定种子：模板里本来没有 seed 参数，追加一个即可（服务端认 seed）。
    if (options.seed !== undefined && options.seed !== null && options.seed !== '') {
      requestUrl += `${requestUrl.includes('?') ? '&' : '?'}seed=${encodeURIComponent(options.seed)}`;
    }

    const startedAt = Date.now();
    const { job, imageUrl } = await submitAndPoll(requestUrl);
    log('出图完成', job.id, `${Date.now() - startedAt}ms`);
    return { imageUrl, jobId: job.id, elapsedMs: Date.now() - startedAt };
  };

  window.__qqInfo = () => {
    const proxy = appProxy();
    return {
      bridgeLoaded: true,
      ready: !!proxy,
      template: proxy ? readTemplate(proxy).slice(0, 120) : '',
      settings: proxy ? {
        model: proxy.settings?.imageModel,
        style: proxy.settings?.imageStyle,
        size: proxy.settings?.imageSize,
        hasToken: !!proxy.settings?.imageGenKey
      } : null
    };
  };

  log('桥接脚本已执行');
  ready.catch(error => log('桥接启动失败', String(error?.message || error)));
})();
