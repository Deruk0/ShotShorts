(() => {
  'use strict';
  const $ = (id) => document.getElementById(`tt-${id}`);
  const api = window.api.tiktok;
  const words = {
    en: {
      heading: 'Publish now · Direct Post', directHint: 'Publish one video immediately. This method uses a separate account connection and developer app keys.', setup: 'TikTok integration settings',
      audit: 'Public posting requires an approved TikTok Direct Post integration. Unaudited apps can only post privately.',
      setupHint: 'Register a Desktop app at developers.tiktok.com with Login Kit and Content Posting API (video.publish). Enter your app credentials locally; do not send them in chat. Disconnect before changing credentials.',
      redirect: 'Register this redirect URI:', save: 'Save integration',
      storage: 'Credentials and tokens are encrypted for your Windows user. A shared public release needs a server to protect the app secret.',
      connect: 'Connect account', disconnect: 'Disconnect', refresh: 'Refresh account', video: 'Video', pick: 'Choose video',
      caption: 'Description and hashtags', privacy: 'Who can watch', choosePrivacy: 'Choose visibility', comment: 'Allow comments',
      duet: 'Allow Duet', stitch: 'Allow Stitch', aigc: 'AI-generated content', commercial: 'Promotes a brand, product or service',
      ownBrand: 'Your brand — Promotional content', branded: 'Another brand — Paid partnership (cannot be private)',
      publish: 'Publish now', cancel: 'Stop waiting / uploading', checkStatus: 'Check publication status',
      processingHint: 'TikTok may take several minutes to process a video. Stopping an upload does not delete a post already accepted by TikTok.',
      consent: 'I authorize publishing this video and agree to TikTok’s ', music: 'Music Usage Confirmation', policy: 'Branded Content Policy',
      and: ' and ', disconnected: 'No TikTok account connected.', connected: 'Account:', limit: 'Maximum video duration:', seconds: 'sec',
      saved: 'Integration saved. Connect your TikTok account.', secretSaved: 'Saved securely; leave blank to keep',
      working: 'Working…', authorizing: 'Complete authorization in your browser.', upload: 'Uploading:',
      uploaded: 'Uploaded. TikTok is processing the post.', complete: 'Published. Requested visibility:', failed: 'TikTok rejected the post:',
      publicPending: 'TikTok has not yet confirmed public availability.',
      interrupted: 'Upload interrupted. Check status before trying again.', status: 'Publication status:',
      stopped: 'Stopped. TikTok may still process a video already received. Check publication status.',
      noFile: 'No video selected.', generated: 'Generated clips', generatedChoose: 'Choose a generated clip',
      PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me',
      credentials_required: 'Enter your TikTok developer app Client key and Client secret in integration settings.',
      account_not_connected: 'Connect a TikTok account first.', consent_required: 'Confirm consent before publishing.',
      privacy_level_option_mismatch: 'Select an available visibility setting. Refresh the account if its settings changed.',
      invalid_caption: 'Description must be at most 2200 UTF-16 units.', invalid_video_duration: 'Video duration must be at least 3 seconds and within the account limit.',
      invalid_video_size: 'Video size must be between 1 byte and 4 GB.', video_probe_failed: 'Cannot read the video. Check the file and FFmpeg installation.',
      invalid_video_file: 'Choose an MP4, MOV or WebM video.',
      unaudited_client_can_only_post_to_private_accounts: 'TikTok has not audited this app. Only private accounts and “Only me” posts are allowed.',
      scope_not_authorized: 'TikTok has not granted video.publish permission. Check app approval and reconnect.',
      video_publish_scope_required: 'TikTok did not grant video.publish. Approve this permission and reconnect.',
      authorization_denied: 'TikTok authorization was denied.', authorization_timeout: 'Authorization timed out. Connect again.',
      oauth_callback_unavailable: 'Local port 8902 is unavailable. Close the app using it and try again.',
      tiktok_network_error: 'Cannot reach TikTok. Check your connection.', secure_storage_unavailable: 'Windows secure credential storage is unavailable.',
      credentials_unreadable: 'Saved TikTok credentials cannot be decrypted by this Windows user.',
      operation_in_progress: 'Wait for the current operation.', operation_cancelled: 'Operation stopped. Check publication status before retrying.',
      post_pending_check_status: 'The last post is still processing. Check its status before posting again.',
      upload_interrupted_check_status: 'Upload interrupted. Check publication status before retrying.',
      commercial_disclosure_required: 'Select your brand, another brand, or both.', branded_content_cannot_be_private: 'Paid partnerships cannot use “Only me”.',
      disconnect_before_configuring: 'Disconnect the account before changing app credentials.',
      rate_limit_exceeded: 'TikTok rate limit reached. Try later.', access_token_invalid: 'TikTok access expired. Reconnect your account.',
      spam_risk_too_many_posts: 'TikTok posting limit reached. Try later.'
    },
    ru: {
      heading: 'Опубликовать сейчас · Direct Post', directHint: 'Разовая публикация видео без расписания. Для этого способа нужны отдельное подключение аккаунта и ключи приложения разработчика.', setup: 'Настройка интеграции TikTok',
      audit: 'Для публичной публикации TikTok должен одобрить интеграцию Direct Post. Без аудита доступны только приватные публикации.',
      setupHint: 'Зарегистрируйте Desktop-приложение на developers.tiktok.com: Login Kit и Content Posting API (video.publish). Введите ключи приложения здесь, не отправляйте их в чат. Перед сменой ключей отключите аккаунт.',
      redirect: 'Зарегистрируйте этот Redirect URI:', save: 'Сохранить интеграцию',
      storage: 'Ключи и токены зашифрованы для вашего пользователя Windows. Для общей публичной сборки нужен сервер, защищающий секрет приложения.',
      connect: 'Подключить аккаунт', disconnect: 'Отключить', refresh: 'Обновить аккаунт', video: 'Видео', pick: 'Выбрать видео',
      caption: 'Описание и хештеги', privacy: 'Кто может смотреть', choosePrivacy: 'Выберите видимость', comment: 'Разрешить комментарии',
      duet: 'Разрешить дуэты', stitch: 'Разрешить сшивание', aigc: 'Контент создан с помощью ИИ', commercial: 'Реклама бренда, товара или услуги',
      ownBrand: 'Свой бренд — отметка «Рекламный контент»', branded: 'Чужой бренд — отметка «Оплаченное партнёрство» (нельзя «Только я»)',
      publish: 'Опубликовать сейчас', cancel: 'Остановить ожидание / загрузку', checkStatus: 'Проверить статус публикации',
      processingHint: 'TikTok может обрабатывать видео несколько минут. Остановка загрузки не удаляет публикацию, уже принятую TikTok.',
      consent: 'Разрешаю публикацию этого видео и принимаю условия TikTok: ', music: 'Подтверждение использования музыки', policy: 'Правила брендированного контента',
      and: ' и ', disconnected: 'Аккаунт TikTok не подключён.', connected: 'Аккаунт:', limit: 'Максимальная длительность:', seconds: 'сек',
      saved: 'Интеграция сохранена. Подключите аккаунт TikTok.', secretSaved: 'Сохранён защищённо; оставьте пустым для сохранения',
      working: 'Выполняется…', authorizing: 'Завершите авторизацию в браузере.', upload: 'Загрузка:',
      uploaded: 'Видео загружено. TikTok обрабатывает публикацию.', complete: 'Опубликовано. Запрошенная видимость:', failed: 'TikTok отклонил публикацию:',
      publicPending: 'TikTok пока не подтвердил публичную доступность.',
      interrupted: 'Загрузка прервана. Проверьте статус перед повторной попыткой.', status: 'Статус публикации:',
      stopped: 'Остановлено. TikTok может продолжить обработку уже полученного видео. Проверьте статус публикации.',
      noFile: 'Видео не выбрано.', generated: 'Готовые клипы', generatedChoose: 'Выберите готовый клип',
      PUBLIC_TO_EVERYONE: 'Все', MUTUAL_FOLLOW_FRIENDS: 'Друзья', FOLLOWER_OF_CREATOR: 'Подписчики', SELF_ONLY: 'Только я',
      credentials_required: 'Введите Client key и Client secret вашего приложения TikTok в настройках интеграции.',
      account_not_connected: 'Сначала подключите аккаунт TikTok.', consent_required: 'Подтвердите согласие на публикацию.',
      privacy_level_option_mismatch: 'Выберите доступную видимость. Если настройки изменились, обновите аккаунт.',
      invalid_caption: 'Описание должно быть не длиннее 2200 единиц UTF-16.', invalid_video_duration: 'Длительность видео должна быть от 3 секунд и не превышать лимит аккаунта.',
      invalid_video_size: 'Размер видео должен быть от 1 байта до 4 ГБ.', video_probe_failed: 'Не удалось прочитать видео. Проверьте файл и установку FFmpeg.',
      invalid_video_file: 'Выберите видео MP4, MOV или WebM.',
      unaudited_client_can_only_post_to_private_accounts: 'Приложение не прошло аудит TikTok. Доступны только приватные аккаунты и публикации «Только я».',
      scope_not_authorized: 'TikTok не предоставил video.publish. Проверьте одобрение приложения и подключите аккаунт заново.',
      video_publish_scope_required: 'TikTok не предоставил video.publish. Разрешите доступ и подключите аккаунт заново.',
      authorization_denied: 'Авторизация TikTok отклонена.', authorization_timeout: 'Время авторизации истекло. Подключите аккаунт заново.',
      oauth_callback_unavailable: 'Локальный порт 8902 занят. Закройте использующее его приложение и повторите попытку.',
      tiktok_network_error: 'Не удалось связаться с TikTok. Проверьте подключение.', secure_storage_unavailable: 'Защищённое хранилище Windows недоступно.',
      credentials_unreadable: 'Этот пользователь Windows не может расшифровать сохранённые ключи TikTok.',
      operation_in_progress: 'Дождитесь завершения текущей операции.', operation_cancelled: 'Операция остановлена. Перед повторной попыткой проверьте статус публикации.',
      post_pending_check_status: 'Предыдущая публикация обрабатывается. Проверьте статус перед новой отправкой.',
      upload_interrupted_check_status: 'Загрузка прервана. Перед повторной попыткой проверьте статус публикации.',
      commercial_disclosure_required: 'Выберите свой бренд, чужой бренд или оба варианта.', branded_content_cannot_be_private: 'Оплаченное партнёрство нельзя публиковать с видимостью «Только я».',
      disconnect_before_configuring: 'Отключите аккаунт перед сменой ключей приложения.',
      rate_limit_exceeded: 'Достигнут лимит запросов TikTok. Повторите позже.', access_token_invalid: 'Доступ TikTok истёк. Подключите аккаунт заново.',
      spam_risk_too_many_posts: 'Достигнут лимит публикаций TikTok. Повторите позже.'
    }
  };
  let lang = 'en';
  let config = {};
  let creator = null;
  let filePath = '';
  let busy = false;
  let timer;
  let lastPost;
  const tr = (key) => words[lang][key] || words.en[key] || key;
  const active = () => ['UPLOADING', 'PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD', 'UPLOAD_INTERRUPTED'].includes(lastPost?.status);
  const result = async (promise) => {
    const response = await promise;
    if (!response.success) throw new Error(response.error);
    return response.data;
  };
  const error = (err) => { $('error').textContent = `${tr(err.message) === err.message ? (lang === 'ru' ? 'Ошибка TikTok: ' : 'TikTok error: ') : ''}${tr(err.message)}`; };
  function controls() {
    $('composer').disabled = busy || !creator;
    $('connect').disabled = busy || config.connected || !config.hasSecret;
    $('disconnect').disabled = busy || !config.connected;
    $('refresh').disabled = busy || !config.connected;
    $('save').disabled = busy || config.connected;
    $('key').disabled = busy || config.connected;
    $('secret').disabled = busy || config.connected;
    $('cancel').hidden = !busy;
    $('status-check').disabled = busy || !lastPost || !config.connected;
    $('publish').disabled = busy || !creator || !filePath || !$('privacy').value || !$('consent').checked || active() ||
      ($('commercial').checked && !$('own-brand').checked && !$('branded').checked);
    for (const key of ['comment', 'duet', 'stitch']) $('' + key).disabled = !creator || !!creator[`${key}_disabled`];
    const privatePost = $('privacy').value === 'SELF_ONLY';
    $('branded').disabled = privatePost;
    const privateOption = Array.from($('privacy').options).find((option) => option.value === 'SELF_ONLY');
    if (privateOption) privateOption.disabled = $('branded').checked;
    window.SharpSelect?.refresh($('privacy'));
    if ($('generated')) { $('generated').disabled = busy || !creator; window.SharpSelect?.refresh($('generated')); }
  }
  function consent() {
    const span = $('consent-text');
    span.replaceChildren(document.createTextNode(tr('consent')));
    const link = (key) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'tiktok-policy'; button.textContent = tr(key);
      button.addEventListener('click', (event) => { event.preventDefault(); api.policy(key).then((r) => { if (!r.success) error(new Error(r.error)); }).catch(error); });
      span.append(button);
    };
    if ($('branded').checked) { link('policy'); span.append(document.createTextNode(tr('and'))); }
    link('music');
  }
  function renderAccount(reset = false) {
    $('account').textContent = creator ? `${tr('connected')} ${creator.creator_nickname} (@${creator.creator_username}) · ${tr('limit')} ${creator.max_video_post_duration_sec} ${tr('seconds')}` : tr('disconnected');
    const previous = reset ? '' : $('privacy').value;
    $('privacy').replaceChildren(Object.assign(new Option('—', ''), { hidden: true, disabled: true }));
    for (const value of creator?.privacy_level_options || []) $('privacy').add(new Option(tr(value), value));
    $('privacy').value = previous;
    if (reset) {
      for (const key of ['comment', 'duet', 'stitch', 'consent']) $(key).checked = false;
    }
    for (const key of ['comment', 'duet', 'stitch']) if (creator?.[`${key}_disabled`]) $(key).checked = false;
    $('secret').placeholder = config.hasSecret ? tr('secretSaved') : '';
    controls();
  }
  function renderPost() {
    if (!lastPost) return;
    const status = lastPost.status;
    $('status').textContent = status === 'PUBLISH_COMPLETE' ? `${tr('complete')} ${tr(lastPost.privacy)}` :
      status === 'FAILED' ? `${tr('failed')} ${lastPost.failReason}` :
        status === 'UPLOAD_INTERRUPTED' ? tr('interrupted') : `${tr('status')} ${status}`;
    $('status').textContent += `\nID: ${lastPost.publishId}`;
    if (status === 'PUBLISH_COMPLETE' && lastPost.privacy === 'PUBLIC_TO_EVERYONE' && !lastPost.postIds?.length) {
      $('status').textContent += `\n${tr('publicPending')}`;
    }
    controls();
  }
  async function work(action, message = 'working') {
    if (busy) return;
    clearTimeout(timer);
    busy = true; $('error').textContent = ''; $('status').textContent = tr(message); controls();
    try { await action(); }
    catch (err) { error(err); }
    finally { busy = false; controls(); }
  }
  async function checkStatus() {
    await work(async () => { lastPost = await result(api.status()); renderPost(); });
    if (active() && lastPost?.status !== 'UPLOAD_INTERRUPTED' && !$('error').textContent) timer = setTimeout(checkStatus, 5000);
  }
  async function refresh() {
    await work(async () => {
      config = await result(api.state());
      $('key').value = config.clientKey;
      lastPost = config.lastPost;
      creator = null;
      renderAccount(true);
      if (config.connected) creator = await result(api.creator());
      $('setup').open = !config.hasSecret;
      renderAccount(true); $('status').textContent = ''; renderPost();
    });
    if (lastPost && config.connected) timer = setTimeout(checkStatus, 5000);
  }
  async function selectFile(selected) {
    await work(async () => {
      const selectedPath = selected || await window.api.openFile([{ name: 'TikTok video', extensions: ['mp4', 'mov', 'webm'] }]);
      if (!selectedPath) { $('status').textContent = ''; return; }
      filePath = ''; $('consent').checked = false; $('preview').hidden = true;
      $('file').textContent = tr('noFile');
      const media = await window.api.probeMedia(selectedPath);
      if (!media.success || media.isImage) throw new Error('video_probe_failed');
      if (!media.thumbnail) throw new Error('video_probe_failed');
      filePath = selectedPath;
      $('file').textContent = filePath;
      $('preview').src = media.thumbnail; $('preview').hidden = false;
      $('status').textContent = ''; renderPost();
    });
  }
  $('save').addEventListener('click', () => work(async () => {
    config = await result(api.configure({ clientKey: $('key').value, clientSecret: $('secret').value }));
    $('secret').value = ''; $('setup').open = false; renderAccount(); $('status').textContent = tr('saved');
  }));
  $('connect').addEventListener('click', () => work(async () => {
    const connected = await result(api.connect());
    config = connected; creator = connected.creator; lastPost = connected.lastPost;
    renderAccount(true); $('status').textContent = '';
  }, 'authorizing'));
  $('disconnect').addEventListener('click', () => work(async () => {
    config = await result(api.disconnect()); creator = null; lastPost = null; renderAccount(true); $('status').textContent = '';
  }));
  $('refresh').addEventListener('click', refresh);
  $('pick').addEventListener('click', () => selectFile());
  $('cancel').addEventListener('click', async () => {
    try { await result(api.cancel()); $('status').textContent = tr('stopped'); }
    catch (err) { error(err); }
  });
  $('status-check').addEventListener('click', checkStatus);
  $('publish').addEventListener('click', async () => {
    if ($('publish').disabled) return;
    const input = { filePath, title: $('caption').value, privacy: $('privacy').value,
      consent: $('consent').checked, commercial: $('commercial').checked, ownBrand: $('own-brand').checked, branded: $('branded').checked,
      comment: $('comment').checked, duet: $('duet').checked, stitch: $('stitch').checked, aigc: $('aigc').checked };
    await work(async () => {
      try { lastPost = await result(api.publish(input)); $('status').textContent = tr('uploaded'); }
      finally {
        $('consent').checked = false;
        const saved = await result(api.state()); config = saved; lastPost = saved.lastPost;
      }
    });
    renderPost();
    if (lastPost) timer = setTimeout(checkStatus, 5000);
  });
  $('composer').addEventListener('input', (event) => {
    if (event.target !== $('consent')) $('consent').checked = false;
    if (!$('commercial').checked) { $('own-brand').checked = false; $('branded').checked = false; }
    $('disclosure').hidden = !$('commercial').checked;
    consent(); controls();
  });
  const unsubscribe = api.onProgress(({ percent }) => { $('status').textContent = `${tr('upload')} ${percent}%`; });
  window.TikTokPanel = {
    refresh,
    setLanguage(value) {
      lang = value === 'ru' ? 'ru' : 'en';
      document.querySelectorAll('[data-tt]').forEach((element) => { element.textContent = tr(element.dataset.tt); });
      if (!filePath) $('file').textContent = tr('noFile');
      if ($('generated')) {
        $('generated-label').textContent = tr('generated');
        $('generated').options[0].textContent = '—';
      }
      consent(); renderAccount(); renderPost();
    },
    setGeneratedFiles(files) {
      let select = $('generated');
      if (!select) {
        const group = document.createElement('div'); group.className = 'field-group';
        const label = document.createElement('label'); label.id = 'tt-generated-label'; label.htmlFor = 'tt-generated'; label.className = 'field-label'; label.textContent = tr('generated');
        select = document.createElement('select'); select.id = 'tt-generated';
        select.addEventListener('change', () => { if (select.value) selectFile(select.value); });
        group.append(label, select); $('media').insertBefore(group, $('pick'));
      }
      select.replaceChildren(Object.assign(new Option('—', ''), { hidden: true, disabled: true }));
      files.filter((file) => typeof file === 'string').forEach((file) => select.add(new Option(file.split(/[\\/]/).pop(), file)));
      window.SharpSelect?.mountAll(); controls();
    }
  };
  window.TikTokPanel.setLanguage(typeof uiLang === 'string' ? uiLang : 'en');
  window.addEventListener('beforeunload', () => { clearTimeout(timer); unsubscribe(); });
})();
