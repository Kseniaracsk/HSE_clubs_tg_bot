'use strict';



const API_BASE = 'https://api.telegram.org/bot';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


function buildB2J(b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    if (!b2j.has(b[j])) b2j.set(b[j], []);
    b2j.get(b[j]).push(j);
  }
  return b2j;
}

function findLongestMatch(a, b, alo, ahi, blo, bhi, b2j) {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const jlist = b2j.get(a[i]) || [];
    for (const j of jlist) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) || 0) + 1;
      if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      newj2len.set(j, k);
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

function matchingBlocks(a, b) {
  const b2j = buildB2J(b);
  const blocks = [];
  (function recurse(alo, ahi, blo, bhi) {
    const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j);
    if (k) {
      recurse(alo, i, blo, j);
      blocks.push([i, j, k]);
      recurse(i + k, ahi, j + k, bhi);
    }
  })(0, a.length, 0, b.length);
  blocks.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]));
  return blocks;
}

function sequenceRatio(a, b) {
  const matches = matchingBlocks(a, b).reduce((sum, [, , size]) => sum + size, 0);
  const total = a.length + b.length;
  return total === 0 ? 1 : (2 * matches) / total;
}


const SEARCH_ALIASES = {
  'хост': 'hostel',
  'хостел': 'hostel',
  'импров': 'improv',
  'пати': 'partytime',
  'патитайм': 'partytime',
  'парти': 'partytime',
  'партитайм': 'partytime',
  'инсайт': 'insight',
  'вальс': 'waltz',
  'хдк': 'hdc',
  'хдц': 'hdc',
  'ивент': 'event',
  'эвент': 'event',
  'евент': 'event',
  'лайв': 'live',
  'букинема': 'bookinema',
  'делис': 'delice',
  'делишес': 'delice',
  'делайс': 'delice',
  'мьюзик': 'music',
  'мюзик': 'music',
  'бэнд': 'band',
  'бенд': 'band',
  'айти': 'коллаб',
  'прога': 'коллаб',
};

function calcWordSimilarity(queryWord, targetWord) {
  const fullRatio = sequenceRatio(queryWord, targetWord);
  const prefixLen = queryWord.length + 1;
  const rootRatio = targetWord.length > queryWord.length
    ? sequenceRatio(queryWord, targetWord.slice(0, prefixLen))
    : 0.0;
  return Math.max(fullRatio, rootRatio);
}

function stripWordChars(w) {
  return w.replace(/^[.,«»"()\[\]!?]+/, '').replace(/[.,«»"()\[\]!?]+$/, '');
}


const MAIN_MENU_KEYBOARD = {
  keyboard: [
    [
      { text: '🔍 Найти клуб' },
      { text: '📂 Каталог клубов' },
    ],
    [
      { text: '⭐ Мои подписки' },
      { text: '💙 Мини-приложение' },
    ],
    [
      { text: '✍️ Идеи и предложения' },
      { text: 'ℹ️ О проекте и помощь' },
    ],
  ],
  resize_keyboard: true,
};

const REPLY_KEYBOARD_REMOVE = { remove_keyboard: true };

function categoriesKeyboard(categories) {
  const buttons = categories.map(([catId, catName]) => ([{ text: catName, callback_data: `category_${catId}` }]));
  buttons.push([{ text: '📋 Показать все клубы списком', callback_data: 'show_all_clubs' }]);
  return { inline_keyboard: buttons };
}

function clubsListKeyboard(clubs, backButton) {
  const buttons = clubs.map(([clubId, clubName]) => ([{ text: clubName, callback_data: `club_${clubId}` }]));
  if (backButton) buttons.push([{ text: '⬅️ Назад к категориям', callback_data: 'back_to_categories' }]);
  return { inline_keyboard: buttons };
}

const SEARCH_NAV_BUTTONS = [
  [
    { text: '🔄 Искать снова', callback_data: 'start_search_again' },
    { text: '📋 Все клубы', callback_data: 'show_all_clubs' },
  ],
  [
    { text: '🏠 Главное меню', callback_data: 'go_to_main_menu' },
  ],
];

const SEARCH_NAV_KEYBOARD = { inline_keyboard: SEARCH_NAV_BUTTONS };


function createBot({ db, botToken, miniAppUrl = '', feedbackChatId = '', log = console }) {

  const states = new Map(); 
  let running = false;


  async function api(method, params = {}, timeoutMs = 40000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(chatId, text, extra = {}) {
    const result = await api('sendMessage', { chat_id: chatId, text, ...extra });
    if (!result.ok) log.error(`Бот: sendMessage ${result.data && result.data.description || result.status}`);
    return result;
  }

  async function editMessageText(callback, text, extra = {}) {
    const result = await api('editMessageText', {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text,
      ...extra,
    });

    if (!result.ok) log.error(`Бот: editMessageText ${result.data && result.data.description || result.status}`);
    return result;
  }

  async function answerCallback(callback) {
    await api('answerCallbackQuery', { callback_query_id: callback.id });
  }


  const getCategories = () => db.prepare('SELECT id, name FROM categories ORDER by name').all()
    .map(row => [Number(row.id), row.name]);

  const getCategoryName = (categoryId) => {
    const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId);
    return row ? row.name : 'Категория';
  };

  const getClubsByCategory = (categoryId) => db
    .prepare('SELECT id, name FROM clubs WHERE category_id = ? AND is_active = 1 ORDER BY name')
    .all(categoryId).map(row => [Number(row.id), row.name]);

  const getClubById = (clubId) => db.prepare(`
    SELECT name, short_description, full_description, telegram_channel_url,
           chairperson_contact, vk_group_url, category_id, application_form_url
    FROM clubs WHERE id = ?`).get(clubId);

  const getAllClubs = () => db
    .prepare('SELECT id, name FROM clubs WHERE is_active = 1 ORDER BY name')
    .all().map(row => [Number(row.id), row.name]);

  const getAllClubRowsForSearch = () => db.prepare(`
    SELECT clubs.id, clubs.name, clubs.short_description, clubs.directions,
           categories.name AS cat_name
    FROM clubs
    LEFT JOIN categories ON clubs.category_id = categories.id
    WHERE clubs.is_active = 1
    ORDER BY clubs.name`).all()
    .map(row => [Number(row.id), row.name, row.short_description, row.directions, row.cat_name]);

  const getUserClubSubscriptions = (tgId) => {
    const user = db.prepare('SELECT id FROM users WHERE telegram_id=?').get(Number(tgId));
    if (!user) return [];
    return db.prepare(`
      SELECT c.id, c.name FROM subscriptions s
      JOIN clubs c ON c.id = s.club_id
      WHERE s.user_id = ? AND c.is_active = 1
      ORDER BY c.name COLLATE NOCASE`).all(user.id)
      .map(row => [Number(row.id), row.name]);
  };

  function searchClubsByName(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const searchTerms = [q];
    for (const [ruKey, targetTerm] of Object.entries(SEARCH_ALIASES)) {
      if (q.includes(ruKey)) searchTerms.push(targetTerm);
    }
    const allClubs = getAllClubRowsForSearch();
    const matchedClubs = [];
    for (const [clubId, name, shortDesc, directions, catName] of allClubs) {
      const searchCorpus = `${name} ${shortDesc || ''} ${directions || ''} ${catName || ''}`.toLowerCase();
      if (searchTerms.some(term => searchCorpus.includes(term))) {
        matchedClubs.push([clubId, name, shortDesc]);
      }
    }
    if (!matchedClubs.length && q.length >= 4) {
      for (const [clubId, name, shortDesc, directions, catName] of allClubs) {
        const searchCorpus = `${name} ${shortDesc || ''} ${directions || ''} ${catName || ''}`.toLowerCase();
        const words = searchCorpus.split(/\s+/).filter(Boolean).map(stripWordChars);
        const bestSimilarity = words.reduce((best, w) => {
          if (w.length < 3) return best;
          return Math.max(best, calcWordSimilarity(q, w));
        }, 0.0);
        if (bestSimilarity >= 0.72) matchedClubs.push([clubId, name, shortDesc]);
      }
    }
    return matchedClubs;
  }


  async function onStart(msg) {
    await send(msg.chat.id,
      '👋 Привет, друг! В этом боте ты сможешь найти всю информацию ' +
      'о внеучебных клубах НИУ ВШЭ – Нижний Новгород\n\n' +
      'Выбери нужный раздел в меню ниже:',
      { reply_markup: MAIN_MENU_KEYBOARD });
  }

  async function onHelp(msg) {
    await send(msg.chat.id,
      'ℹ️ О проекте «Внеучебка ВШЭ – Нижний Новгород»\n\n' +
      'Этот бот создан студентами для студентов, чтобы собрать все 27 внеучебных клубов и объединений кампуса в одном месте 💙\n\n' +
      '❓ Как пользоваться:\n' +
      '• Каталог клубов — выбери направление (творчество, спорт, наука и др.) и найди клуб по душе.\n' +
      '• Найти клуб — быстрый поиск по названию.\n' +
      '• 💙 Мини-приложение — интерактивный визуальный каталог с фото и атмосферой клубов.\n' +
      '• ✍️ Идеи и предложения — предложить новый клуб или исправление.\n\n' +
      '🛠 Поддержка и обратная связь:\n' +
      'Нашли баг, клуб сменил контакты или есть вопрос?\n' +
      '💬 Напишите нам напрямую: @racsk\n\n' +
      'Или нажмите кнопку «✍️ Идеи и предложения» в меню ниже — сообщение сразу уйдёт команде проекта!\n\n' +
      '🌐 Сайт внеучебки: https://nnov.hse.ru/nnovstudents/about\n' +
      '📢 Канал «активННик HSE»: https://t.me/aktivnnik');
  }

  async function onMiniApp(msg) {
    if (miniAppUrl) {
      await send(msg.chat.id, '💙 Визуальный каталог внеучебки', {
        reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть мини-приложение', web_app: { url: miniAppUrl } }]] },
      });
    } else {
      await send(msg.chat.id,
        '💙 **Визуальный каталог внеучебки (Mini App)**\n\n' +
        'Здесь будет открываться интерактивное приложение с каруселями фотографий и атмосферой клубов!\n\n' +
        '*(Дизайн и верстка сейчас в разработке у команды)*',
        { parse_mode: 'Markdown' });
    }
  }

  async function onCatalog(msg) {
    await send(msg.chat.id,
      '📂 Выбери категорию или посмотри все клубы сразу:',
      { reply_markup: categoriesKeyboard(getCategories()) });
  }

  async function onSearch(msg) {
    states.set(msg.chat.id, 'search');
    await send(msg.chat.id,
      '🔍 **Поиск клубов**\n\n' +
      'Введи название клуба или ключевое слово (например: *дебат*, *вокал*, *спорт*):',
      { parse_mode: 'Markdown' });
  }

  async function onSearchInput(msg, text) {
    const userQuery = text.trim();
    states.delete(msg.chat.id);
    const clubs = searchClubsByName(userQuery);
    if (!clubs.length) {
      await send(msg.chat.id,
        `По запросу «${userQuery}» ничего не нашлось.\n\n` +
        'Попробуй ввести другое слово или открой список всех клубов:',
        { reply_markup: SEARCH_NAV_KEYBOARD });
      return;
    }
    const keyboard = clubsListKeyboard(clubs, false);
    keyboard.inline_keyboard.push(...SEARCH_NAV_BUTTONS);
    await send(msg.chat.id,
      `🎯 Найдено клубов: **${clubs.length}**\n` +
      'Нажми на клуб, чтобы открыть его карточку:',
      { reply_markup: keyboard, parse_mode: 'Markdown' });
  }

  async function onSubscriptions(msg) {
    const clubs = getUserClubSubscriptions(msg.from && msg.from.id);
    if (!clubs.length) {
      await send(msg.chat.id,
        '⭐ У тебя пока нет подписок на клубы.\n\n' +
        'Открой 💙 Мини-приложение или 📂 Каталог клубов и нажми на звёздочку у понравившегося клуба — он появится здесь.');
      return;
    }
    const buttons = clubs.map(([clubId, clubName]) => {
      const shortName = clubName.length > 40 ? `${clubName.slice(0, 39)}…` : clubName;
      return [{ text: `⭐ ${shortName}`, callback_data: `club_${clubId}` }];
    });
    if (miniAppUrl) buttons.push([{ text: '💙 Открыть мини-приложение', web_app: { url: miniAppUrl } }]);
    await send(msg.chat.id,
      `⭐ **Твои подписки (${clubs.length})**\n\nНажми на клуб, чтобы открыть его карточку:`,
      { reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' });
  }

  async function onSuggest(msg) {
    states.set(msg.chat.id, 'feedback');
    await send(msg.chat.id,
      '✍️ **Идеи и предложения**\n\n' +
      'Напиши своё предложение, идею нового клуба или сообщение об ошибке одним сообщением.\n\n' +
      'Мы передадим его напрямую команде проекта!',
      {
        reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'cancel_feedback' }]] },
        parse_mode: 'Markdown',
      });
  }

  async function onFeedbackInput(msg, text) {
    states.delete(msg.chat.id);
    const senderName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    const username = msg.from.username ? `@${msg.from.username}` : 'нет username';
    const userId = msg.from.id;
    const adminMessage =
      '📬 **Новое предложение от студента!**\n\n' +
      `👤 **Отправитель:** ${senderName} (${username})\n` +
      `🆔 **ID:** \`${userId}\`\n\n` +
      `📝 **Текст:**\n${text}`;
    if (feedbackChatId) {
      try {
        await send(feedbackChatId, adminMessage, { reply_markup: REPLY_KEYBOARD_REMOVE, parse_mode: 'Markdown' });
      } catch (error) {
        log.error(`Бот: не удалось отправить сообщение модераторам: ${error.message}`);
      }
    }
    await send(msg.chat.id,
      '💙 Спасибо за обратную связь! Мы передали твоё сообщение команде проекта.',
      { reply_markup: MAIN_MENU_KEYBOARD });
  }


  async function onUnknown(msg) {
    await send(msg.chat.id,
      '🤖Я пока не знаю такую команду\n\n' +
      'Пожалуйста, выбери нужный раздел в меню ниже',
      { reply_markup: MAIN_MENU_KEYBOARD, parse_mode: 'Markdown' });
  }

  async function handleMessage(msg) {
    if (!msg || msg.chat.type !== 'private') return; // dp.message.filter(F.chat.type == "private")
    const text = typeof msg.text === 'string' ? msg.text : null;
    const state = states.get(msg.chat.id) || null;
    if (/^\/start(?:@\w+)?(?:\s|$)/.test(text || '')) return onStart(msg);
    if (/^\/help(?:@\w+)?(?:\s|$)/.test(text || '') || text === 'ℹ️ О проекте и помощь') return onHelp(msg);
    if (/^\/app(?:@\w+)?(?:\s|$)/.test(text || '') || text === '💙 Мини-приложение') return onMiniApp(msg);
    if (text === '📂 Каталог клубов') return onCatalog(msg);
    if (text === '🔍 Найти клуб') return onSearch(msg);
    if (state === 'search' && text != null) return onSearchInput(msg, text);
    if (text === '⭐ Мои подписки') return onSubscriptions(msg);
    if (text === '✍️ Идеи и предложения') return onSuggest(msg);
    if (state === 'feedback' && text != null) return onFeedbackInput(msg, text);
    return onUnknown(msg);
  }


  async function onCategoryClick(callback) {
    const categoryId = Number(callback.data.split('_')[1]);
    const categoryName = getCategoryName(categoryId);
    const clubs = getClubsByCategory(categoryId);
    let text;
    if (clubs.length) {
      text = `📂 Клубы направления **${categoryName}** (${clubs.length}):\n\nВыбери клуб, чтобы открыть карточку:`;
    } else {
      text = `📂 В направлении **${categoryName}** пока нет активных клубов.`;
    }
    await editMessageText(callback, text, { reply_markup: clubsListKeyboard(clubs, true), parse_mode: 'Markdown' });
  }


  async function onBackToCategories(callback) {
    await editMessageText(callback,
      '📂 Выбери категорию или посмотри все клубы сразу:',
      { reply_markup: categoriesKeyboard(getCategories()) });
  }


  async function onShowAllClubs(callback) {
    const clubs = getAllClubs();
    if (!clubs.length) {
      await send(callback.message.chat.id, 'Список клубов пока пуст.');
      return;
    }
    await editMessageText(callback, '📋 Список всех клубов Вышки:', { reply_markup: clubsListKeyboard(clubs, false) });
  }


  async function onClubClick(callback) {
    const clubId = Number(callback.data.split('_')[1]);
    const club = getClubById(clubId);
    if (!club) {
      await send(callback.message.chat.id, 'Информация о клубе не найдена.');
      return;
    }
    const [name, shortDesc, fullDesc, tgUrl, curator, vkUrl, categoryId, appFormUrl] = [
      club.name, club.short_description, club.full_description, club.telegram_channel_url,
      club.chairperson_contact, club.vk_group_url, club.category_id, club.application_form_url,
    ];
    const desc = fullDesc ? fullDesc : shortDesc;
    const cleanDesc = desc.trim()
      .replace(/\n\s*\n+/g, '\n\n')
      .split('* ').join('• ')
      .split('_').join('\\_');
    let text = `✨ **${name}**\n\n${cleanDesc}\n`;
    if (appFormUrl) text += `\n📝 **Форма регистрации:** [заполнить анкету](${appFormUrl})\n`;
    if (curator) {
      const cleanCurator = curator.split('_').join('\\_');
      text += `\n👤 Куратор: ${cleanCurator}`;
    }
    const cardButtons = [];
    if (appFormUrl) cardButtons.push([{ text: '📝 Подать заявку', url: appFormUrl }]);
    const socialRow = [];
    if (tgUrl) socialRow.push({ text: '⭐ Подписаться', url: tgUrl });
    if (vkUrl) socialRow.push({ text: '🌐 ВК', url: vkUrl });
    if (socialRow.length) cardButtons.push(socialRow);
    cardButtons.push([
      { text: '⬅️ К направлению', callback_data: `category_${categoryId}` },
      { text: '📋 Все клубы', callback_data: 'show_all_clubs' },
    ]);
    await send(callback.message.chat.id, text, { reply_markup: { inline_keyboard: cardButtons }, parse_mode: 'Markdown' });
  }

  async function onSearchAgain(callback) {
    states.set(callback.message.chat.id, 'search');
    await send(callback.message.chat.id,
      '🔍 **Новый поиск**\n\n' +
      'Введи название клуба или ключевое слово (например: *дебат*, *вокал*, *спорт*):',
      { parse_mode: 'Markdown' });
  }

  async function onGoToMainMenu(callback) {
    await send(callback.message.chat.id, 'Главное меню:', { reply_markup: MAIN_MENU_KEYBOARD });
  }

  async function onCancelFeedback(callback) {
    states.delete(callback.message.chat.id);
    await editMessageText(callback, 'Действие отменено.');
    await send(callback.message.chat.id, 'Главное меню:', { reply_markup: MAIN_MENU_KEYBOARD });
  }

  async function handleCallback(callback) {
    await answerCallback(callback);
    const data = callback.data || '';
    if (data.startsWith('category_')) return onCategoryClick(callback);
    if (data === 'back_to_categories') return onBackToCategories(callback);
    if (data === 'show_all_clubs') return onShowAllClubs(callback);
    if (data.startsWith('club_')) return onClubClick(callback);
    if (data === 'start_search_again') return onSearchAgain(callback);
    if (data === 'go_to_main_menu') return onGoToMainMenu(callback);
    if (data === 'cancel_feedback') return onCancelFeedback(callback);
    // Неизвестный callback в aiogram тоже никак не обрабатывался.
  }

  async function handleUpdate(update) {
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
  }

  async function pollingLoop() {
    let offset = 0;
    let delay = 3000;
    while (running) {
      try {
        const result = await api('getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        });
        if (result.ok) {
          delay = 3000;
          for (const update of result.data.result || []) {
            offset = Math.max(offset, update.update_id + 1);
            try { await handleUpdate(update); } catch (error) {
              log.error(`Бот: ошибка обработки апдейта: ${error.message}`);
            }
          }
          continue;
        }
        const description = (result.data && result.data.description) || `HTTP ${result.status}`;
        if (result.status === 409) {
          log.error('Бот: 409 Conflict — getUpdates уже выполняется другим процессом (например, старым Python-ботом). Остановите дубликат.');
        } else if (result.status === 401) {
          log.error('Бот: 401 Unauthorized — проверьте TELEGRAM_BOT_TOKEN.');
        } else {
          log.error(`Бот: getUpdates ${description}`);
        }
      } catch (error) {
        log.error(`Бот: нет связи с api.telegram.org (${error.message}), повтор через ${Math.round(Math.min(delay, 30000) / 1000)} с`);
      }
      await sleep(Math.min(delay, 30000));
      delay = Math.min(delay * 2, 30000);
    }
  }

  async function start() {
    running = true;
    let announced = false;
    while (running) {
      let me;
      try {
        me = await api('getMe', {}, 15000);
      } catch (error) {
        log.error(`Бот: нет связи с api.telegram.org (${error.message}), повтор через 5 с`);
        await sleep(5000);
        continue;
      }
      if (me.ok) {
        if (!announced) {
          log.log(`Бот запущен: @${me.data.result.username}`);
          announced = true;
        }
        await api('setMyCommands', {
          commands: [
            { command: 'start', description: 'Главное меню' },
            { command: 'help', description: 'О проекте и помощь' },
            { command: 'app', description: 'Открыть мини-приложение' },
          ],
        });
        log.log('Бот успешно запущен и слушает Telegram...');
        return pollingLoop();
      }
      const description = (me.data && me.data.description) || `HTTP ${me.status}`;
      if (me.status === 401) {
        log.error(`Бот остановлен: неверный токен (getMe: ${description}).`);
        running = false;
        return;
      }
      log.error(`Бот: getMe ${description}, повтор через 5 с`);
      await sleep(5000);
    }
  }

  function stop() { running = false; }

  return { start, stop };
}

function startBot({ db, log = console } = {}) {
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  if (!botToken) {
    log.warn('Бот не запущен: не задан TELEGRAM_BOT_TOKEN (или BOT_TOKEN).');
    return null;
  }
  const miniAppUrl = String(process.env.MINI_APP_URL || '').trim();
  const feedbackChatId = String(process.env.FEEDBACK_CHAT_ID || '').trim();
  const bot = createBot({ db, botToken, miniAppUrl, feedbackChatId, log });
  bot.start().catch((error) => log.error(`Бот остановлен с ошибкой: ${error.message}`));
  return bot;
}

module.exports = { createBot, startBot };
