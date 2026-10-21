(() => {
  'use strict';
  const root = document.getElementById('tiktok-queue-panel');
  const api = window.api.tiktok.queue;
  const strings = {
    ru: {
      statisticsTitle: 'Статистика TikTok', statisticsRefresh: 'Обновить статистику', statisticsEmpty: 'Статистика за этот период ещё не загружалась.',
      statisticsScope: 'Общие показатели аккаунта за выбранный период из аналитики TikTok Studio.',
      statisticsUpdated: 'Статистика сохранена.', statisticsWorking: 'Обновляю статистику. Если загружается ролик, дождусь завершения его отправки.',
      statisticsDate: 'Обновлено', statisticsViews: 'Просмотры', statisticsLikes: 'Лайки', statisticsComments: 'Комментарии',
      statisticsPeriod: 'Период', statisticsDays: 'дней', statisticsPublished: 'Последний опубликованный ролик', statisticsScheduled: 'Последний ролик в расписании', statisticsNone: 'Нет роликов', statisticsUnavailable: '— означает: TikTok не предоставил показатель.', invalid_statistics_period: 'Выберите доступный период статистики.', statisticsAccount: 'Аккаунт статистики',
      studio_statistics_unavailable: 'Не удалось прочитать статистику Studio. Предыдущие данные сохранены. Проверьте вход и доступ к аналитике Studio.',
      statistics_storage_error: 'Не удалось прочитать или сохранить статистику.',
      applySchedule: 'Сохранить и применить время ко всем черновикам',
      applyScheduleHint: 'Распределяет время у готовых черновиков по первой дате и интервалу. Занятые слоты пропускаются. Описания и остальные настройки роликов сохраняются.',
      scheduleApplied: 'Время публикаций обновлено у всех черновиков.',
      queue_no_drafts: 'В списке нет черновиков для изменения времени.',
      autoRemoveUploaded: 'Автоматически убирать из списка после подтверждённой загрузки в TikTok',
      autoRemoveHint: 'Применяется к следующим загрузкам. Файлы на компьютере и ролики в TikTok сохраняются.',
      openVideo: 'Открыть видео', videoOpened: 'Видео открыто в видеоплеере.',
      video_file_missing: 'Файл видео не найден. Возможно, он перемещён или удалён.',
      video_open_failed: 'Не удалось открыть видео. Проверьте установленный видеоплеер.',
      invalid_video_file: 'Ролик больше недоступен в списке или формат файла не поддерживается.',
      insertPreset: 'Вставить сохранённый шаблон', chooseCaptionPreset: 'Выберите шаблон', lockedDefaults: 'Закройте редактор ролика, чтобы менять общие настройки.', presets: 'Пресеты описаний и хештегов', captionPreset: 'Пресет описания', hashtagPresetId: 'Пресет хештегов', none: 'Без пресета', newPreset: 'Новый пресет', presetName: 'Название пресета', captionTemplate: 'Шаблон описания', tags: 'Хештеги', minCount: 'Минимум хештегов', maxCount: 'Максимум хештегов', savePreset: 'Сохранить пресет', deletePreset: 'Удалить пресет', presetSaved: 'Пресет сохранён.', previewCaption: 'Пример результата', applyCaption: 'Вставить в описание', preview: 'Итоговое описание', captionCommands: '{name} — имя файла без расширения; {filename} — с расширением; {n} — номер; {hashtags} — случайные хештеги. Любой другой текст сохраняется. Если {hashtags} нет, выбранные хештеги добавятся в конце.', hashtagHint: 'Введите хештеги через пробел, запятую или с новой строки. Знак # необязателен. Количество и порядок случайные; повторов нет. Если тегов меньше минимума, используются все доступные.', invalid_hashtags: 'Введите от 1 до 200 хештегов: буквы, цифры или _.', invalid_hashtag_range: 'Количество хештегов: целые числа от 1 до 200; минимум не больше максимума.', invalid_preset_name: 'Введите название пресета длиной до 80 символов.', preset_name_exists: 'Пресет с таким названием уже есть. Выберите его для изменения.', preset_not_found: 'Пресет не найден.', hashtag_preset_not_found: 'Пресет хештегов не найден. Выберите другой.', invalid_caption_sample: 'Не удалось определить имя файла для описания.', unsaved: 'Есть несохранённые изменения. Сначала сохраните их или закройте редактирование.',
      refreshAccounts: 'Обновить аккаунты', addAccount: 'Добавить аккаунт', chooseAccount: 'Выберите аккаунт', pendingAccount: 'Продолжить вход', accountsHint: 'После входа закройте окно браузера и нажмите «Обновить аккаунты». Выберите аккаунт в настройках новых роликов или отдельно для каждого видео.', accountsUpdated: 'Аккаунты обновлены. Выберите аккаунт для публикации.', noAccounts: 'Войдите в TikTok Studio и обновите список аккаунтов.', studio_account_unavailable: 'Не удалось определить аккаунт. Откройте его окно Studio, завершите вход и нажмите «Обновить аккаунты».', studio_accounts_unreadable: 'Не удалось прочитать список аккаунтов.',
      connection: '1. Аккаунт TikTok Studio', clips: '3. Очередь роликов', delivery: 'Отправка в расписание', schedule: 'Время публикаций', content: 'Описание и доступ', automation: 'Автозагрузка', templateStep: '2. Настройки новых роликов',
      heading: 'План публикаций', intro: 'Готовые ролики автоматически добавляются сюда после обработки. Каждому ролику можно задать своё время и настройки. Видео загружаются заранее в расписание TikTok Studio.',
      open: 'Открыть TikTok Studio / войти', login: 'Один раз войдите в TikTok в отдельном окне браузера. Для этого способа ключи разработчика не нужны. После входа закройте это окно и нажмите «Обновить аккаунты».',
      template: 'Настройки для новых роликов', account: 'Аккаунт для публикации', firstAt: 'Первая публикация', intervalMinutes: 'Интервал между роликами (мин)',
      title: 'Описание и хештеги', templateHint: '{name} — имя клипа, {n} — номер в плане. Настройки применяются только к новым роликам.',
      privacy: 'Кто может смотреть', PUBLIC_TO_EVERYONE: 'Все', MUTUAL_FOLLOW_FRIENDS: 'Друзья', FOLLOWER_OF_CREATOR: 'Подписчики', SELF_ONLY: 'Только я', choose: 'Выберите видимость',
      comment: 'Разрешить комментарии', reuse: 'Разрешить повторное использование контента', aigc: 'Контент создан с помощью ИИ',
      autoUpload: 'Автоматически загружать новые готовые ролики в расписание TikTok по этим настройкам',
      saveTemplate: 'Сохранить настройки', empty: 'После генерации здесь появятся готовые ролики.', video: 'Ролик', time: 'Публикация', state: 'Статус',
      edit: 'Настроить', remove: 'Убрать из плана', save: 'Сохранить ролик', close: 'Закрыть', scheduledAt: 'Дата и время публикации',
      draft: 'Черновик', ready: 'В очереди загрузки', uploading: 'Загружается в TikTok', scheduled: 'Запланировано в TikTok', needs_attention: 'Нужна проверка в TikTok',
      send: 'Загрузить настроенные ролики в TikTok', consent: 'Разрешаю загрузить настроенные ролики и поставить их в расписание TikTok. Я имею права на видео и музыку.',
      pause: 'Остановить загрузку очереди', resume: 'Продолжить очередь', paused: 'Очередь остановлена.',
      zone: 'Часовой пояс:', limits: 'Время указывается с шагом 5 минут, минимум за 15 минут до публикации. Лимиты дат проверяет TikTok. Коммерческий контент отправляйте через отдельную форму Direct Post ниже.',
      reconcile: 'Проверьте ролик в TikTok Studio: повторная отправка автоматически заблокирована.',
      confirmed: 'Уже запланировано в TikTok', notSent: 'Не запланировано — вернуть в план',
      localOnly: 'Без даты', saved: 'План сохранён.', changed: 'Настройки изменены. Сохраните их перед отправкой.',
      working: 'Выполняется…', browserOpened: 'Окно TikTok Studio открыто. Войдите в нужный аккаунт, закройте это окно и нажмите «Обновить аккаунты».',
      loginBrowser: 'Браузер для нового аккаунта',
      browserHint: 'Выбор применяется при добавлении аккаунта. Сохранённые аккаунты открываются в своём браузере. Для другого браузера потребуется новый вход.',
      studio_chrome_unavailable: 'Не удалось открыть Chrome. Проверьте установку Google Chrome.',
      studio_browser_invalid: 'Выберите Chrome или Edge.',
      studio_browser_state_unavailable: 'Не удалось проверить окна браузера. Закройте окна входа, открытые программой, и повторите обновление аккаунтов.',
      studio_login_window_open: 'Завершите вход и закройте окно браузера, открытое программой. Затем нажмите «Обновить аккаунты».',
      studio_edge_unavailable: 'Не удалось открыть отдельный профиль Edge. Проверьте установку Microsoft Edge.',
      studio_account_required: 'Укажите имя аккаунта TikTok без @.', invalid_schedule_time: 'Укажите корректные дату и время.',
      schedule_requires_five_minutes: 'Минуты должны быть кратны 5: 00, 05, 10 и далее.',
      studio_schedule_too_soon: 'До публикации должно оставаться минимум 15 минут.', schedule_time_in_past: 'Время публикации уже прошло.',
      invalid_schedule_interval: 'Интервал должен быть от 5 до 10080 минут и кратен 5.',
      queue_item_not_editable: 'Этот ролик уже передан в очередь. Сначала проверьте его статус.',
      queue_unreadable: 'Не удалось прочитать сохранённую очередь.', queue_storage_error: 'Не удалось сохранить очередь.',
      consent_required: 'Подтвердите загрузку роликов.', privacy_level_option_mismatch: 'Выберите видимость публикации.',
      invalid_caption: 'Описание слишком длинное: максимум 2200 единиц UTF-16.',
      studio_layout_changed: 'Форма TikTok изменилась. Проверьте открытое окно.',
      removeLocalHint: '«Убрать из плана» удаляет запись только из приложения. Файл и публикация в TikTok сохраняются.',
      studio_upload_timeout: 'Не удалось дождаться формы загрузки TikTok Studio. Проверьте вход в аккаунт.',
      studio_upload_not_ready: 'Видео или форма TikTok не стали готовы за 30 минут. Проверьте загрузку и сообщения TikTok.',
      studio_upload_navigation_timeout: 'Не удалось открыть форму загрузки TikTok для следующего ролика.',
      studio_file_input_timeout: 'Страница TikTok открыта, но поле выбора видео не появилось.',
      studio_schedule_button_disabled: 'Кнопка «Запланировать» осталась недоступной после ожидания 30 минут. Проверьте загрузку, обработку видео и сообщения TikTok.',
      expectedAccount: 'Аккаунт в плане', actualAccount: 'Аккаунт на странице TikTok', unknownAccount: 'не определён',
      studio_caption_timeout: 'Не удалось заполнить описание. Проверьте загрузку видео и всплывающие окна TikTok.',
      studio_schedule_timeout: 'Не удалось включить расписание. Проверьте переключатель времени публикации в TikTok.',
      studio_date_timeout: 'Не удалось выбрать дату публикации в календаре TikTok.',
      studio_time_timeout: 'Не удалось выбрать время публикации в TikTok.',
      studio_time_open_timeout: 'Не удалось открыть список времени в TikTok.',
      studio_time_hour_timeout: 'Не удалось выбрать час публикации в списке времени TikTok.',
      studio_time_minute_timeout: 'Не удалось выбрать минуты публикации в списке времени TikTok.',
      studio_time_close_timeout: 'Время выбрано, но не удалось закрыть список времени. Проверьте всплывающие окна TikTok.',
      studio_privacy_timeout: 'Не удалось выбрать видимость публикации в TikTok.',
      studio_options_timeout: 'Не удалось открыть или изменить дополнительные настройки TikTok.',
      studio_ai_label_timeout: 'Не удалось найти переключатель «Контент, сгенерированный ИИ» в раскрытых настройках TikTok.',
      studio_reuse_unavailable: 'Предыдущая версия остановила отправку из-за недоступного повторного использования. Верните ролик в план и отправьте снова: теперь эта настройка не блокирует публикацию.',
      studio_reuse_disabled_by_tiktok: 'TikTok отключил повторное использование для этого видео. Ролик запланирован с выключенным повторным использованием.',
      studio_account_mismatch: 'В TikTok открыт другой аккаунт. Загрузка остановлена.',
      studio_setting_unavailable: 'TikTok не разрешает одну из выбранных настроек для этого видео.',
      studio_settings_not_applied: 'TikTok не применил выбранные настройки. Отправка остановлена.',
      studio_setting_not_applied: 'Не удалось применить переключатель TikTok.',
      studio_schedule_unavailable: 'Эта дата недоступна в календаре TikTok.',
      studio_needs_attention: 'Проверьте окно TikTok: возможны вход, CAPTCHA или изменение формы.',
      studio_submission_needs_review: 'Нажатие отправки выполнено, но результат нужно проверить в TikTok. Автоматического повтора не будет.',
      studio_interrupted_check_status: 'Загрузка прервана. Проверьте TikTok перед повторной отправкой.'
    },
    en: {
      statisticsTitle: 'TikTok statistics', statisticsRefresh: 'Refresh statistics', statisticsEmpty: 'Statistics for this period have not been loaded yet.',
      statisticsScope: 'Overall account metrics for the selected period from TikTok Studio analytics.',
      statisticsUpdated: 'Statistics saved.', statisticsWorking: 'Refreshing statistics. Any active video upload will finish first.',
      statisticsDate: 'Updated', statisticsViews: 'Views', statisticsLikes: 'Likes', statisticsComments: 'Comments',
      statisticsPeriod: 'Period', statisticsDays: 'days', statisticsPublished: 'Latest published video', statisticsScheduled: 'Latest scheduled video', statisticsNone: 'No videos', statisticsUnavailable: '— means TikTok did not provide this metric.', invalid_statistics_period: 'Choose an available statistics period.', statisticsAccount: 'Statistics account',
      studio_statistics_unavailable: 'Could not read Studio statistics. Previous data is kept. Check sign-in and Studio analytics access.',
      statistics_storage_error: 'Could not read or save statistics.',
      applySchedule: 'Save and apply timing to all drafts',
      applyScheduleHint: 'Assigns draft times using the first date and interval, skipping occupied slots. Video captions and other settings are kept.',
      scheduleApplied: 'Publication times updated for all drafts.',
      queue_no_drafts: 'There are no drafts to reschedule.',
      autoRemoveUploaded: 'Automatically remove from this list after confirmed upload to TikTok',
      autoRemoveHint: 'Applies to future uploads. Local files and videos on TikTok are kept.',
      openVideo: 'Open video', videoOpened: 'Video opened in your video player.',
      video_file_missing: 'Video file not found. It may have been moved or deleted.',
      video_open_failed: 'Could not open the video. Check your installed video player.',
      invalid_video_file: 'The video is no longer in the list or its file format is unsupported.',
      insertPreset: 'Insert a saved template', chooseCaptionPreset: 'Choose a template', lockedDefaults: 'Close the clip editor to change defaults.', presets: 'Caption and hashtag presets', captionPreset: 'Caption preset', hashtagPresetId: 'Hashtag preset', none: 'No preset', newPreset: 'New preset', presetName: 'Preset name', captionTemplate: 'Caption template', tags: 'Hashtags', minCount: 'Minimum hashtags', maxCount: 'Maximum hashtags', savePreset: 'Save preset', deletePreset: 'Delete preset', presetSaved: 'Preset saved.', previewCaption: 'Preview result', applyCaption: 'Insert into caption', preview: 'Final caption', captionCommands: '{name}: filename without extension; {filename}: with extension; {n}: number; {hashtags}: random hashtags. Other text is kept. Selected hashtags are appended when {hashtags} is absent.', hashtagHint: 'Separate tags with spaces, commas, or new lines. # is optional. Count and order are random, without duplicates. Smaller pools use all available tags.', invalid_hashtags: 'Enter 1 to 200 hashtags using letters, digits, or _.', invalid_hashtag_range: 'Use whole numbers from 1 to 200; minimum must not exceed maximum.', invalid_preset_name: 'Enter a preset name up to 80 characters.', preset_name_exists: 'This preset name exists. Select it to edit.', preset_not_found: 'Preset not found.', hashtag_preset_not_found: 'Hashtag preset not found. Choose another.', invalid_caption_sample: 'Cannot determine the filename for this caption.', unsaved: 'Save your changes or close the editor first.',
      refreshAccounts: 'Refresh accounts', addAccount: 'Add account', chooseAccount: 'Choose an account', pendingAccount: 'Continue sign-in', accountsHint: 'After signing in, close the browser window and click Refresh accounts. Choose an account in defaults or separately for each video.', accountsUpdated: 'Accounts refreshed. Choose an account for publication.', noAccounts: 'Sign in to TikTok Studio, then refresh accounts.', studio_account_unavailable: 'Cannot detect the account. Open its Studio window, finish signing in, then refresh accounts.', studio_accounts_unreadable: 'Cannot read the saved account list.',
      loginBrowser: 'Browser for a new account',
      browserHint: 'Applies when adding an account. Saved accounts open in their own browser. Another browser requires a new sign-in.',
      studio_chrome_unavailable: 'Could not open Chrome. Check that Google Chrome is installed.',
      studio_edge_unavailable: 'Could not open Edge. Check that Microsoft Edge is installed.',
      studio_browser_invalid: 'Choose Chrome or Edge.',
      studio_browser_state_unavailable: 'Could not check browser windows. Close sign-in windows opened by the app, then refresh accounts again.',
      studio_login_window_open: 'Finish signing in and close the browser window opened by the app. Then click Refresh accounts.',
      connection: '1. TikTok Studio account', clips: '3. Clip queue', delivery: 'Send to scheduler', schedule: 'Publication times', content: 'Description and visibility', automation: 'Automatic uploads', templateStep: '2. Defaults for new clips',
      heading: 'Publication plan', intro: 'Generated clips appear here automatically. Give each clip its own time and settings. Videos are uploaded ahead of time to TikTok Studio’s scheduler.',
      open: 'Open TikTok Studio / sign in', login: 'Sign in once in the separate browser window. Developer keys are not required for this method. After signing in, close this window and click Refresh accounts.',
      template: 'Defaults for new clips', account: 'Publication account', firstAt: 'First publication', intervalMinutes: 'Interval between clips (min)',
      title: 'Description and hashtags', templateHint: '{name} is the clip name; {n} is its number in the plan. Defaults apply only to new clips.',
      privacy: 'Who can watch', PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me', choose: 'Choose visibility',
      comment: 'Allow comments', reuse: 'Allow reuse of content', aigc: 'AI-generated content', autoUpload: 'Automatically upload newly generated clips to TikTok’s scheduler using these settings',
      saveTemplate: 'Save defaults', empty: 'Generated videos will appear here after processing.', video: 'Video', time: 'Publication', state: 'Status',
      edit: 'Configure', remove: 'Remove from plan', save: 'Save clip', close: 'Close', scheduledAt: 'Publication date and time',
      draft: 'Draft', ready: 'Waiting to upload', uploading: 'Uploading to TikTok', scheduled: 'Scheduled on TikTok', needs_attention: 'Check TikTok',
      send: 'Upload configured clips to TikTok', consent: 'I authorize uploading and scheduling these clips on TikTok. I have rights to the videos and music.',
      pause: 'Stop queue uploads', resume: 'Resume queue', paused: 'Queue is paused.', zone: 'Time zone:',
      limits: 'Use 5-minute increments, at least 15 minutes before publication. TikTok validates its date limits. Use the separate Direct Post form below for commercial content.',
      reconcile: 'Check this clip in TikTok Studio before retrying; automatic retries are blocked.', confirmed: 'Already scheduled on TikTok', notSent: 'Not scheduled — return to plan',
      localOnly: 'No date', saved: 'Plan saved.', changed: 'Settings changed. Save before sending.', working: 'Working…', browserOpened: 'TikTok Studio is open. Sign in, close the browser window, then click Refresh accounts.',
      studio_upload_timeout: 'The TikTok Studio upload form did not appear. Check that you are signed in.',
      studio_upload_not_ready: 'The video or TikTok form was not ready within 30 minutes. Check upload progress and TikTok messages.',
      studio_upload_navigation_timeout: 'Could not open the TikTok upload form for the next video.',
      studio_file_input_timeout: 'TikTok opened, but the video file input did not appear.',
      studio_schedule_button_disabled: 'Schedule remained disabled after waiting 30 minutes. Check video upload, processing and TikTok messages.',
      expectedAccount: 'Account in plan', actualAccount: 'Account on TikTok page', unknownAccount: 'unknown',
      studio_caption_timeout: 'Could not fill the description. Check video upload progress and TikTok popups.',
      studio_schedule_timeout: 'Could not enable scheduling. Check the publication time control in TikTok.',
      studio_date_timeout: 'Could not select the publication date in TikTok.',
      studio_time_timeout: 'Could not select the publication time in TikTok.',
      studio_time_open_timeout: 'Could not open the TikTok time picker.',
      studio_time_hour_timeout: 'Could not select the publication hour in TikTok.',
      studio_time_minute_timeout: 'Could not select the publication minutes in TikTok.',
      studio_time_close_timeout: 'The time was selected, but its picker could not be dismissed. Check for TikTok popups.',
      studio_privacy_timeout: 'Could not select publication visibility in TikTok.',
      studio_options_timeout: 'Could not open or change additional TikTok settings.',
      studio_ai_label_timeout: 'Could not find the AI-generated content switch in the expanded TikTok settings.',
      studio_reuse_unavailable: 'The previous version stopped because reuse was unavailable. Return the clip to the plan and send it again: this restriction no longer blocks submission.',
      studio_reuse_disabled_by_tiktok: 'TikTok disabled reuse for this video. The clip was scheduled with reuse turned off.',
      removeLocalHint: 'Remove from plan only removes the entry from this app. The file and TikTok publication are kept.'
    }
  };
  let lang = 'en';
  let data = { template: {}, items: [] };
  let accounts = [];
  let statistics = { accounts: [] };
  let statisticsAccountId;
  let statisticsDays = 7;
  let loginBrowser = 'msedge';
  let selected = null;
  let templateOpen;
  let modalOpen = false;
  let dirty = false;
  let busy = false;
  const tr = (key) => strings[lang][key] || strings.en[key] || key;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
  const $ = (id) => document.getElementById(`tq-${id}`);
  const localValue = (value) => {
    if (!value) return '';
    const d = new Date(value); const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const isoValue = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || localValue(date.toISOString()) !== value) throw new Error('invalid_schedule_time');
    return date.toISOString();
  };
  function field(parent, name, type, value = '') {
    const group = el('div', '', 'field-group'); const id = `tq-${parent.id}-${name}`;
    const label = el('label', tr(name), 'field-label'); label.htmlFor = id;
    const input = el(type === 'textarea' ? 'textarea' : 'input'); input.id = id;
    if (type !== 'textarea') input.type = type;
    else { input.rows = 3; input.maxLength = 2200; }
    if (type === 'datetime-local') input.step = '300';
    input.value = value; group.append(label, input); parent.append(group); return input;
  }
  function button(text, action, cls = 'btn btn-secondary') {
    const node = el('button', tr(text), cls); node.type = 'button'; node.addEventListener('click', action); return node;
  }
  function checkbox(parent, name, checked = false) {
    const label = el('label', '', 'toggle-label');
    const input = el('input'); input.type = 'checkbox'; input.checked = checked; input.id = `tq-${parent.id}-${name}`;
    label.append(input, el('span', tr(name))); parent.append(label); return input;
  }
  function markDirty() {
    dirty = true; status.textContent = tr('changed');
    const send = $('send'); if (send) send.disabled = true;
    const consent = document.getElementById('tq-tiktok-queue-panel-consent'); if (consent) consent.checked = false;
  }
  function canLeave() {
    if (!dirty) return true;
    alert.textContent = tr('unsaved');
    return false;
  }
  function presetSelect(parent, name, kind, selected = '', empty = 'none') {
    const group = el('div', '', 'field-group');
    const select = el('select'); select.id = `tq-${parent.id}-${name}`; select.dataset.presetKind = kind;
    select.dataset.emptyLabel = empty;
    const label = el('label', tr(name), 'field-label'); label.htmlFor = select.id;
    group.append(label, select); parent.append(group);
    populatePresets(select, selected);
    return select;
  }
  function populatePresets(select, selected = select.value) {
    const empty = select.dataset.emptyLabel === 'chooseCaptionPreset'
      ? Object.assign(new Option('—', ''), { hidden: true, disabled: true })
      : new Option(tr(select.dataset.emptyLabel), '');
    select.replaceChildren(empty);
    for (const entry of data[select.dataset.presetKind] || []) select.add(new Option(entry.name, entry.id));
    select.value = [...select.options].some(option => option.value === selected) ? selected : '';
    if (select.isConnected) window.SharpSelect?.refresh(select);
  }
  function syncPresets() {
    root.querySelectorAll('select[data-preset-kind]').forEach(select => populatePresets(select));
  }
  function captionTools(parent, titleInput, item) {
    const box = el(item ? 'details' : 'div', '', 'caption-tools'); box.id = `${parent.id}-captions`;
    if (item) box.append(el('summary', tr('captionTemplate')));
    const chooser = presetSelect(box, 'captionPreset', 'captionPresets', '', 'chooseCaptionPreset');
    box.querySelector('label').textContent = tr('insertPreset');
    const raw = item ? field(box, 'captionTemplate', 'textarea', data.template.title || '{name}') : titleInput;
    const hashtags = presetSelect(box, 'hashtagPresetId', 'hashtagPresets', data.template.hashtagPresetId || '');
    const tokens = el('div', '', 'caption-tokens');
    for (const token of ['{name}', '{filename}', '{n}', '{hashtags}']) {
      const insert = el('button', token, 'btn btn-secondary'); insert.type = 'button';
      insert.addEventListener('click', () => {
        raw.setRangeText(token, raw.selectionStart, raw.selectionEnd, 'end');
        raw.dispatchEvent(new Event('input', { bubbles: true })); raw.focus();
      }); tokens.append(insert);
    }
    box.append(tokens, el('p', tr('captionCommands'), 'hint'));
    const preview = el('p', '', 'caption-preview'); preview.hidden = true;
    preview.setAttribute('role', 'status');
    const actions = el('div', '', 'tiktok-actions');
    actions.append(button(item ? 'applyCaption' : 'previewCaption', async () => {
      try {
        const title = await result(api.previewCaption({ title: raw.value, hashtagPresetId: hashtags.value,
          fileName: item?.filePath || 'Имя видео.mp4', number: item ? data.items.findIndex(entry => entry.id === item.id) + 1 : 1 }));
        preview.textContent = `${tr('preview')}:\n${title}\n${title.length} / 2200`; preview.hidden = false;
        if (item) { titleInput.value = title; titleInput.dispatchEvent(new Event('input', { bubbles: true })); }
      } catch (error) { alert.textContent = tr(error.message); }
    }), button('presets', managePresets));
    chooser.addEventListener('change', () => {
      const preset = (data.captionPresets || []).find(entry => entry.id === chooser.value);
      if (!preset) return;
      raw.value = preset.title; hashtags.value = preset.hashtagPresetId || '';
      window.SharpSelect?.refresh(hashtags);
      raw.dispatchEvent(new Event('input', { bubbles: true })); preview.hidden = true;
    });
    raw.addEventListener('input', () => { preview.hidden = true; });
    hashtags.addEventListener('change', () => { preview.hidden = true; });
    box.append(actions, preview); parent.append(box);
    return hashtags;
  }
  function managePresets() {
    if (modalOpen) return;
    modalOpen = true;
    const dialog = el('dialog', '', 'caption-presets-dialog'); dialog.id = 'tq-presets-dialog';
    const heading = el('h3', tr('presets'), 'section-title'); heading.id = 'tq-presets-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    const columns = el('div', '', 'caption-preset-columns');
    const captions = el('section'); captions.id = 'caption-library';
    const hashtags = el('section'); hashtags.id = 'hashtag-library';
    const captionChoice = presetSelect(captions, 'captionPreset', 'captionPresets', '', 'newPreset');
    const captionName = field(captions, 'presetName', 'text'); captionName.maxLength = 80;
    const captionTitle = field(captions, 'captionTemplate', 'textarea', '{name} {hashtags}');
    const captionTags = presetSelect(captions, 'hashtagPresetId', 'hashtagPresets');
    captions.append(el('p', tr('captionCommands'), 'hint'));
    const hashtagChoice = presetSelect(hashtags, 'hashtagPresetId', 'hashtagPresets', '', 'newPreset');
    const hashtagName = field(hashtags, 'presetName', 'text'); hashtagName.maxLength = 80;
    const tags = field(hashtags, 'tags', 'textarea'); tags.maxLength = 20000;
    const min = field(hashtags, 'minCount', 'number', 3);
    const max = field(hashtags, 'maxCount', 'number', 5);
    for (const input of [min, max]) { input.min = '1'; input.max = '200'; input.step = '1'; }
    const range = el('div', '', 'tiktok-field-grid'); range.append(min.parentElement, max.parentElement); hashtags.append(range);
    hashtags.append(el('p', tr('hashtagHint'), 'hint'));
    const message = el('p', '', 'hint'); message.setAttribute('role', 'status');
    const error = el('p', '', 'warning'); error.setAttribute('role', 'alert');
    const loadCaption = () => {
      const preset = (data.captionPresets || []).find(entry => entry.id === captionChoice.value);
      captionName.value = preset?.name || ''; captionTitle.value = preset?.title || '{name} {hashtags}';
      captionTags.value = preset?.hashtagPresetId || ''; window.SharpSelect?.refresh(captionTags);
    };
    const loadHashtags = () => {
      const preset = (data.hashtagPresets || []).find(entry => entry.id === hashtagChoice.value);
      hashtagName.value = preset?.name || ''; tags.value = preset?.tags.join(' ') || '';
      min.value = preset?.minCount ?? 3; max.value = preset?.maxCount ?? 5;
    };
    captionChoice.addEventListener('change', loadCaption); hashtagChoice.addEventListener('change', loadHashtags);
    let saving = false;
    const run = async action => {
      if (saving) return;
      saving = true; error.textContent = ''; message.textContent = tr('working');
      dialog.querySelectorAll('button').forEach(node => { node.disabled = true; });
      try { data = await action(); syncPresets(); message.textContent = tr('presetSaved'); }
      catch (failure) { error.textContent = tr(failure.message); message.textContent = ''; }
      finally { saving = false; dialog.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    };
    const captionActions = el('div', '', 'tiktok-actions');
    captionActions.append(button('savePreset', () => run(async () => {
      const updated = await result(api.saveCaptionPreset({ id: captionChoice.value || undefined, name: captionName.value,
        title: captionTitle.value, hashtagPresetId: captionTags.value }));
      data = updated; populatePresets(captionChoice, updated.captionPresets.find(entry => entry.name === captionName.value.trim()).id);
      return updated;
    }), 'btn btn-primary'), button('deletePreset', () => {
      if (captionChoice.value) run(() => result(api.removeCaptionPreset(captionChoice.value)));
    })); captions.append(captionActions);
    const hashtagActions = el('div', '', 'tiktok-actions');
    hashtagActions.append(button('savePreset', () => run(async () => {
      const updated = await result(api.saveHashtagPreset({ id: hashtagChoice.value || undefined, name: hashtagName.value,
        tags: tags.value, minCount: Number(min.value), maxCount: Number(max.value) }));
      data = updated; populatePresets(hashtagChoice, updated.hashtagPresets.find(entry => entry.name === hashtagName.value.trim()).id);
      return updated;
    }), 'btn btn-primary'), button('deletePreset', () => {
      if (hashtagChoice.value) run(() => result(api.removeHashtagPreset(hashtagChoice.value)));
    })); hashtags.append(hashtagActions);
    const close = button('close', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { modalOpen = false; dialog.remove(); if (!dirty) render(); });
    columns.append(captions, hashtags); dialog.append(heading, columns, message, error, close); root.append(dialog);
    window.SharpSelect?.mountAll(dialog); dialog.showModal();
  }
  function settingsFields(parent, value, item) {
    const accountGroup = el('div', '', 'field-group');
    const account = el('select'); account.id = `tq-${parent.id}-account`;
    const accountLabel = el('label', tr('account'), 'field-label'); accountLabel.htmlFor = account.id;
    account.add(Object.assign(new Option('—', ''), { hidden: true, disabled: true }));
    const usernames = [...new Set(accounts.map(entry => entry.username).filter(Boolean))];
    for (const username of usernames) account.add(new Option(`@${username}`, username));
    if (value.account && !usernames.includes(value.account)) account.add(new Option(`@${value.account}`, value.account));
    account.value = value.account || (usernames.length === 1 ? usernames[0] : '');
    accountGroup.append(accountLabel, account); parent.append(accountGroup);
    const title = field(parent, 'title', 'textarea', value.title || '');
    if (!item) title.parentElement.querySelector('label').textContent = tr('captionTemplate');
    const captions = captionTools(parent, title, item);
    const group = el('div', '', 'field-group'); const label = el('label', tr('privacy'), 'field-label');
    const privacy = el('select'); privacy.id = `tq-${parent.id}-privacy`; label.htmlFor = privacy.id;
    privacy.add(Object.assign(new Option('—', ''), { hidden: true, disabled: true }));
    for (const key of ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']) privacy.add(new Option(tr(key), key));
    privacy.value = value.privacy || ''; group.append(label, privacy); parent.append(group);
    const checks = el('div', '', 'tiktok-checks'); checks.id = `${parent.id}-checks`; parent.append(checks);
    const comment = checkbox(checks, 'comment', value.comment); const reuse = checkbox(checks, 'reuse', value.reuse); const aigc = checkbox(checks, 'aigc', value.aigc);
    return { read: () => ({ account: account.value, title: title.value, ...(!item ? { hashtagPresetId: captions.value } : {}), privacy: privacy.value, comment: comment.checked, reuse: reuse.checked, aigc: aigc.checked }) };
  }
  const status = el('p', '', 'hint'); status.id = 'tq-status'; status.setAttribute('role', 'status');
  const alert = el('p', '', 'warning'); alert.id = 'tq-error'; alert.setAttribute('role', 'alert');
  async function result(promise) { const r = await promise; if (!r.success) throw new Error(r.error); return r.data; }
  async function perform(fn) {
    if (busy) return;
    busy = true; root.classList.add('queue-busy'); alert.textContent = ''; status.textContent = tr('working');
    try { await fn(); if (status.textContent === tr('working')) status.textContent = tr('saved'); }
    catch (error) { alert.textContent = tr(error.message); status.textContent = ''; }
    finally { busy = false; root.classList.remove('queue-busy'); if (!dirty && !modalOpen) render(); }
  }
  function statisticsCard() {
    const card = el('section', '', 'tiktok-card queue-statistics');
    card.append(el('h3', tr('statisticsTitle'), 'tiktok-block-title'), el('p', tr('statisticsScope'), 'hint'));
    const available = accounts.filter(entry => entry.username);
    if (!available.some(entry => entry.id === statisticsAccountId)) statisticsAccountId = available[0]?.id;
    const tools = el('div', '', 'tiktok-actions');
    const group = el('div', '', 'field-group');
    const label = el('label', tr('statisticsAccount'), 'field-label'); label.htmlFor = 'tq-statistics-account';
    const choice = el('select'); choice.id = label.htmlFor;
    for (const entry of available) choice.add(new Option(`@${entry.username}`, entry.id));
    choice.value = statisticsAccountId || ''; choice.disabled = !available.length;
    choice.addEventListener('change', () => {
      statisticsAccountId = choice.value;
      const replacement = statisticsCard(); card.replaceWith(replacement); window.SharpSelect?.mountAll(replacement);
    });
    group.append(label, choice); tools.append(group);
    const periodGroup = el('div', '', 'field-group');
    const periodLabel = el('label', tr('statisticsPeriod'), 'field-label'); periodLabel.htmlFor = 'tq-statistics-period';
    const period = el('select'); period.id = periodLabel.htmlFor;
    for (const days of [7, 28, 60, 365]) period.add(new Option(`${days} ${tr('statisticsDays')}`, String(days)));
    period.value = String(statisticsDays);
    period.addEventListener('change', () => {
      statisticsDays = Number(period.value);
      const replacement = statisticsCard(); card.replaceWith(replacement); window.SharpSelect?.mountAll(replacement);
    });
    periodGroup.append(periodLabel, period); tools.append(periodGroup);
    const update = button('statisticsRefresh', () => perform(async () => {
      status.textContent = tr('statisticsWorking');
      statistics = await result(api.refreshStatistics({ id: choice.value, days: statisticsDays }));
      const replacement = statisticsCard(); card.replaceWith(replacement); window.SharpSelect?.mountAll(replacement);
      status.textContent = tr('statisticsUpdated');
    }));
    update.disabled = !available.length; tools.append(update); card.append(tools);
    const account = available.find(entry => entry.id === statisticsAccountId)?.username;
    const summaries = statistics.accounts.filter(entry => entry.account === account && entry.scope === 'account_summary');
    const snapshot = summaries.find(entry => entry.days === statisticsDays);
    const latest = [...summaries].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const dates = el('div', '', 'statistics-dates');
    for (const [key, title] of [['lastPublishedAt', 'statisticsPublished'], ['lastScheduledAt', 'statisticsScheduled']]) {
      const block = el('div', '', 'statistics-summary'); block.append(el('span', tr(title), 'hint'));
      const value = latest?.[key];
      const time = el('time', value ? new Date(value).toLocaleString(lang) : latest ? tr('statisticsNone') : '—');
      if (value) time.dateTime = value;
      block.append(time); dates.append(block);
    }
    card.append(dates);
    if (!snapshot) { card.append(el('p', tr('statisticsEmpty'), 'hint')); return card; }
    card.append(el('p', `${tr('statisticsDate')}: ${new Date(snapshot.updatedAt).toLocaleString(lang)}`, 'hint'));
    const metrics = el('div', '', 'statistics-metrics');
    for (const [key, label] of [['views', 'statisticsViews'], ['likes', 'statisticsLikes'], ['comments', 'statisticsComments']]) {
      const block = el('div', '', 'statistics-summary'); block.dataset.metric = key;
      block.append(el('span', tr(label), 'hint'), el('strong', snapshot.metrics[key] === null ? '—' : snapshot.metrics[key].toLocaleString(lang)));
      metrics.append(block);
    }
    card.append(metrics);
    if (Object.values(snapshot.metrics).some(value => value === null)) card.append(el('p', tr('statisticsUnavailable'), 'hint'));
    return card;
  }

  function render() {
    const scroller = root.closest('.tab-content');
    const scrollTop = scroller?.scrollTop;
    root.replaceChildren(el('div', tr('heading'), 'section-title'), el('p', tr('intro'), 'hint'));
    const connection = el('section', '', 'tiktok-card queue-connection');
    const connectionInfo = el('div'); connectionInfo.append(el('h3', tr('connection'), 'tiktok-block-title'), el('p', tr('login'), 'hint'));
    connection.append(connectionInfo, button('open', () => perform(async () => { await result(api.openStudio()); status.textContent = tr('browserOpened'); })));
    const accountActions = el('div', '', 'tiktok-actions');
    const browserGroup = el('div', '', 'field-group');
    const browserLabel = el('label', tr('loginBrowser'), 'field-label'); browserLabel.htmlFor = 'tq-login-browser';
    const browserSelect = el('select'); browserSelect.id = 'tq-login-browser';
    browserSelect.add(new Option('Microsoft Edge', 'msedge')); browserSelect.add(new Option('Google Chrome', 'chrome'));
    browserSelect.value = loginBrowser;
    browserSelect.addEventListener('change', () => { loginBrowser = browserSelect.value; });
    browserGroup.append(browserLabel, browserSelect, el('p', tr('browserHint'), 'hint')); connectionInfo.append(browserGroup);
    accountActions.append(connection.lastElementChild,
      button('refreshAccounts', () => perform(async () => {
        if (dirty) throw new Error('changed');
        accounts = await result(api.refreshAccounts()); status.textContent = tr('accountsUpdated');
      })),
      button('addAccount', () => perform(async () => {
        if (dirty) throw new Error('changed');
        accounts = await result(api.addAccount(loginBrowser)); status.textContent = tr('browserOpened');
      })));
    connection.append(accountActions); root.append(connection);
    const accountList = el('div', '', 'queue-accounts');
    for (const entry of accounts) {
      const accountButton = el('button', entry.username ? `@${entry.username}` : tr('pendingAccount'), 'btn btn-secondary');
      accountButton.title = entry.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
      accountButton.type = 'button'; accountButton.addEventListener('click', () => perform(async () => {
        await result(api.openStudio(entry.id)); status.textContent = tr('browserOpened');
      })); accountList.append(accountButton);
    }
    if (!accounts.some(entry => entry.username)) accountList.append(el('p', tr('noAccounts'), 'hint'));
    connectionInfo.append(el('p', tr('accountsHint'), 'hint'), accountList);
    root.append(statisticsCard());
    const libraryActions = el('div', '', 'tiktok-actions'); libraryActions.append(button('presets', managePresets)); root.append(libraryActions);
    const workspace = el('div', '', 'queue-workspace'); root.append(workspace);
    const details = el('details'); details.open = templateOpen ?? (!data.template.firstAt && !data.items.length); details.className = 'queue-template tiktok-card';
    const summary = el('summary', '', 'subsection-title collapsible-title'); summary.append(el('span', '▾', 'chevron'), el('span', tr('templateStep'))); details.append(summary);
    summary.addEventListener('click', () => { templateOpen = !details.open; });
    const form = el('div'); form.id = 'defaults'; details.append(form);
    form.append(el('h4', tr('schedule'), 'tiktok-group-title'));
    const first = field(form, 'firstAt', 'datetime-local', localValue(data.template.firstAt));
    const interval = field(form, 'intervalMinutes', 'number', data.template.intervalMinutes || 60); interval.min = '5'; interval.max = '10080'; interval.step = '5';
    const timing = el('div', '', 'tiktok-field-grid'); timing.append(first.parentElement, interval.parentElement); form.append(timing);
    form.append(el('p', `${tr('zone')} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, 'hint'), el('p', tr('limits'), 'hint'));
    form.append(el('h4', tr('content'), 'tiktok-group-title'));
    const defaults = settingsFields(form, data.template);
    form.prepend(form.querySelector('#tq-defaults-account').parentElement);
    form.append(el('p', tr('templateHint'), 'hint'));
    const automation = el('div', '', 'queue-automation'); automation.append(el('h4', tr('automation'), 'tiktok-group-title'));
    const auto = checkbox(form, 'autoUpload', data.template.autoUpload);
    automation.append(auto.parentElement); form.append(automation);
    const templateActions = el('div', '', 'tiktok-actions'); form.append(templateActions);
    templateActions.append(button('saveTemplate', () => perform(async () => {
      data = await result(api.template({ ...defaults.read(), firstAt: isoValue(first.value), intervalMinutes: Number(interval.value), autoUpload: auto.checked }));
      dirty = false; render();
    }), 'btn btn-primary'));
    const applySchedule = button('applySchedule', () => perform(async () => {
      data = await result(api.template({ ...defaults.read(), firstAt: isoValue(first.value), intervalMinutes: Number(interval.value), autoUpload: auto.checked, applySchedule: true }));
      dirty = false; status.textContent = tr('scheduleApplied'); render();
    }));
    applySchedule.disabled = !data.items.some(item => item.status === 'draft');
    templateActions.append(applySchedule);
    form.append(el('p', tr('applyScheduleHint'), 'hint'));
    form.addEventListener('input', markDirty);
    if (selected) {
      form.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = true; });
      form.classList.add('queue-defaults-locked');
      details.append(el('p', tr('lockedDefaults'), 'hint'));
    }
    workspace.append(details);
    const plan = el('section', '', 'tiktok-card queue-plan'); workspace.append(plan);
    const planHeading = el('div', '', 'queue-plan-heading'); planHeading.append(el('h3', tr('clips'), 'tiktok-block-title'), el('span', String(data.items.length), 'queue-count')); plan.append(planHeading);
    plan.append(el('p', tr('removeLocalHint'), 'hint'));
    const list = el('div', '', 'queue-list'); plan.append(list);
    if (!data.items.length) list.append(el('p', tr('empty'), 'hint'));
    for (const item of data.items) {
      const card = el('div', '', 'queue-item'); card.dataset.id = item.id;
      const itemHeading = el('div', '', 'queue-item-heading'); itemHeading.append(el('div', item.name, 'field-label'), el('span', tr(item.status), 'queue-state')); card.append(itemHeading);
      card.append(el('p', `${item.scheduledAt ? new Date(item.scheduledAt).toLocaleString(lang) : tr('localOnly')} · ${tr(item.settings.privacy || 'choose')}${item.account ? ` · @${item.account}` : ''}`, 'hint'));
      if (item.settings.title) card.append(el('p', item.settings.title, 'queue-caption'));
      if (item.error) card.append(el('p', tr(item.error), 'warning'));
      if (item.accountCheck) card.append(el('p', `${tr('expectedAccount')}: @${item.accountCheck.expected} · ${tr('actualAccount')}: ${item.accountCheck.actual ? `@${item.accountCheck.actual}` : tr('unknownAccount')}`, 'hint'));
      for (const warning of item.receipt?.warnings || []) card.append(el('p', tr(warning), 'hint'));
      const actions = el('div', '', 'tiktok-actions'); card.append(actions);
      actions.append(button('openVideo', () => perform(async () => {
        await result(api.openVideo(item.id)); status.textContent = tr('videoOpened');
      })));
      if (item.status === 'draft') {
        actions.append(button('edit', () => { if (!canLeave()) return; selected = item.id; dirty = false; render(); document.getElementById('tq-editor')?.scrollIntoView({ block: 'nearest' }); }));
      }
      if (['draft', 'ready', 'scheduled', 'needs_attention'].includes(item.status)) {
        actions.append(button('remove', () => perform(async () => { if (!canLeave()) return; data = await result(api.remove(item.id)); if (selected === item.id) selected = null; render(); })));
      }
      if (item.status === 'needs_attention') {
        card.append(el('p', tr('reconcile'), 'hint'));
        for (const [key, nextState] of [['confirmed', 'scheduled'], ['notSent', 'draft']]) actions.append(button(key, () => perform(async () => {
          data = await result(api.reconcile({ id: item.id, status: nextState }));
        })));
      }
      if (selected === item.id && item.status === 'draft') {
        const editor = el('div', '', 'queue-editor'); editor.id = 'tq-editor';
        const at = field(editor, 'scheduledAt', 'datetime-local', localValue(item.scheduledAt));
        const fields = settingsFields(editor, { ...item.settings, account: item.account }, item);
        const row = el('div', '', 'tiktok-actions');
        row.append(button('save', () => perform(async () => {
          const { account, ...settings } = fields.read();
          data = await result(api.update({ id: item.id, account, settings, scheduledAt: isoValue(at.value) }));
          dirty = false; selected = null; render();
        }), 'btn btn-primary'), button('close', () => { selected = null; dirty = false; render(); }));
        editor.addEventListener('input', markDirty);
        editor.append(row); card.append(editor);
      }
      list.append(card);
    }
    const delivery = el('div', '', 'queue-delivery'); delivery.append(el('h4', tr('delivery'), 'tiktok-group-title')); plan.append(delivery);
    const autoRemove = checkbox(delivery, 'autoRemoveUploaded', data.autoRemoveUploaded);
    delivery.append(el('p', tr('autoRemoveHint'), 'hint'));
    autoRemove.addEventListener('change', () => perform(async () => {
      data = await result(api.preferences({ autoRemoveUploaded: autoRemove.checked }));
    }));
    const consent = checkbox(root, 'consent'); delivery.append(consent.parentElement);
    const actions = el('div', '', 'tiktok-actions');
    const send = button('send', () => perform(async () => {
      if (dirty) throw new Error('changed');
      const ids = data.items.filter((item) => item.status === 'draft' && item.scheduledAt && item.settings.privacy && item.account).map((item) => item.id);
      data = await result(api.send({ ids, consent: consent.checked })); render();
    }), 'btn btn-primary');
    send.id = 'tq-send';
    send.disabled = true; consent.addEventListener('change', () => { send.disabled = !consent.checked || dirty || !data.items.some((item) => item.status === 'draft' && item.scheduledAt && item.account && item.settings.privacy); });
    actions.append(send, button('pause', () => perform(async () => { data = await result(api.pause()); })));
    if (data.paused) actions.append(button('resume', () => perform(async () => { data = await result(api.resume()); })));
    delivery.append(actions);
    if (data.paused) delivery.append(el('p', tr('paused'), 'hint'));
    connectionInfo.append(status, alert);
    window.SharpSelect?.mountAll(root);
    // Rebuilding the panel can temporarily shrink it and clamp scrollTop.
    // Restore after controls are mounted; the browser clamps only at the new end.
    if (scroller) scroller.scrollTo({ top: scrollTop, behavior: 'instant' });
  }
  async function refresh() {
    try {
      const [plan, savedAccounts, savedStatistics] = await Promise.all([result(api.get()), result(api.accounts()), result(api.statistics()).catch(() => null)]);
      data = plan; accounts = savedAccounts;
      if (savedStatistics) statistics = savedStatistics;
      else alert.textContent = tr('statistics_storage_error');
      if (!dirty && !busy && !modalOpen) render();
    }
    catch (error) { alert.textContent = tr(error.message); if (!alert.isConnected) root.append(alert); }
  }
  window.TikTokQueuePanel = { refresh, setLanguage(value) { lang = value === 'ru' ? 'ru' : 'en'; if (!dirty && !modalOpen) render(); } };
  const unsubscribe = api.onChanged(refresh);
  window.addEventListener('beforeunload', unsubscribe);
  window.TikTokQueuePanel.setLanguage(typeof uiLang === 'string' ? uiLang : 'en');
  refresh();
})();
