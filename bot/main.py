import os
import re
import asyncio 
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart, Command, StateFilter
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, BotCommand, ReplyKeyboardRemove, WebAppInfo
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
import aiosqlite
from difflib import SequenceMatcher

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN")
FEEDBACK_CHAT_ID = os.getenv("FEEDBACK_CHAT_ID")
MINI_APP_URL = os.getenv("MINI_APP_URL")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())
dp.message.filter(F.chat.type == "private")

main_menu_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [
            KeyboardButton(text="🔍 Найти клуб"),
            KeyboardButton(text="📂 Каталог клубов")
        ],
        [
            KeyboardButton(text="⭐ Мои клубы"),
            KeyboardButton(text="💙 Мини-приложение")
        ],
        [
            KeyboardButton(text="✍️ Идеи и правки"),
            KeyboardButton(text="ℹ️ О проекте и помощь")
        ]
    ],
    resize_keyboard=True
)

if os.path.exists("/data/hse_nn_clubs.db"):
    DB_PATH = "/data/hse_nn_clubs.db"
else:
    DB_PATH = os.getenv("SQLITE_DB_PATH", "hse_nn_clubs.db")
    
class SearchClub(StatesGroup):
    waiting_for_name = State()

class Feedback(StatesGroup):
    waiting_for_text = State()

async def get_categories():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id, name FROM categories ORDER by name") as cursor:
            return await cursor.fetchall()

async def get_category_name(category_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT name FROM categories WHERE id = ?", (category_id,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else "Категория"

async def get_clubs_by_category(category_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, name FROM clubs WHERE category_id = ? AND is_active = 1 ORDER BY name",
            (category_id,)
        ) as cursor:
            return await cursor.fetchall()

async def get_club_by_id(club_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT name, short_description, full_description, telegram_channel_url, chairperson_contact, vk_group_url, category_id, application_form_url FROM clubs WHERE id = ?",
            (club_id,)
        ) as cursor:
            return await cursor.fetchone() 

async def get_all_clubs():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id, name FROM clubs WHERE is_active = 1 ORDER BY name") as cursor:
            return await cursor.fetchall()

async def get_or_create_user(user):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM users WHERE telegram_id = ?", (user.id,)) as cursor:
            row = await cursor.fetchone()
            if row:
                return row[0]
        cursor = await db.execute(
            "INSERT INTO users (telegram_id, chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?, ?)",
            (user.id, user.id, user.username, user.first_name, user.last_name)
        )
        await db.commit()
        return cursor.lastrowid

async def get_saved_clubs_by_user(user_db_id):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            SELECT c.id, c.name, c.telegram_channel_url, c.vk_group_url
            FROM clubs c
            JOIN subscriptions s ON c.id = s.club_id
            WHERE s.user_id = ? AND c.is_active = 1
            ORDER BY c.name
            """,
            (user_db_id,)
        ) as cursor:
            return await cursor.fetchall()

async def is_club_saved(user_db_id, club_id):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM subscriptions WHERE user_id = ? AND club_id = ?",
            (user_db_id, club_id)
        ) as cursor:
            row = await cursor.fetchone()
            return bool(row)

async def save_club_to_user(user_db_id, club_id):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM subscriptions WHERE user_id = ? AND club_id = ?",
            (user_db_id, club_id)
        ) as cursor:
            if not await cursor.fetchone():
                await db.execute(
                    "INSERT INTO subscriptions (user_id, club_id) VALUES (?, ?)",
                    (user_db_id, club_id)
                )
                await db.commit()

async def remove_club_from_user(user_db_id, club_id):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM subscriptions WHERE user_id = ? AND club_id = ?",
            (user_db_id, club_id)
        )
        await db.commit()



#переводчик со слэнга и англа
SEARCH_ALIASES = {
    "хост": "hostel",
    "хостел": "hostel",
    "импров": "improv",
    "пати": "partytime",
    "патитайм": "partytime",
    "парти": "partytime",
    "партитайм": "partytime",
    "инсайт": "insight",
    "вальс": "waltz",
    "хдк": "hdc",
    "хдц": "hdc",
    "ивент": "event",
    "эвент": "event",
    "евент": "event",
    "лайв": "live",
    "букинема": "bookinema",
    "делис": "delice",
    "делишес": "delice",
    "делайс": "delice",
    "мьюзик": "music",
    "мюзик": "music",
    "бэнд": "band",
    "бенд": "band",
    "айти": "коллаб",
    "прога": "коллаб",
}

def calc_word_similarity(query_word: str, target_word: str):
    full_ratio = SequenceMatcher(None, query_word, target_word).ratio()
    prefix_len = len(query_word) + 1
    root_ratio = SequenceMatcher(None, query_word, target_word[:prefix_len]).ratio() if len(target_word) > len(query_word) else 0.0
    return max(full_ratio, root_ratio)

async def search_clubs_by_name(query: str):
    q = query.lower().strip()
    if not q:
        return []
    search_terms = [q]
    for ru_key, target_term in SEARCH_ALIASES.items():
        if ru_key in q:
            search_terms.append(target_term)
    async with aiosqlite.connect(DB_PATH) as db:
        sql = """
            SELECT clubs.id, clubs.name, clubs.short_description, clubs.directions, categories.name
            FROM clubs
            LEFT JOIN categories ON clubs.category_id = categories.id
            WHERE clubs.is_active = 1
            ORDER BY clubs.name
        """
        async with db.execute(sql) as cursor:
            all_clubs = await cursor.fetchall()
    matched_clubs = []
    for club_id, name, short_desc, directions, cat_name in all_clubs:
        search_corpus = f"{name} {short_desc or ''} {directions or ''} {cat_name or ''}".lower()
        if any(term in search_corpus for term in search_terms):
            matched_clubs.append((club_id, name, short_desc))
    if not matched_clubs and len(q) >= 4:
        for club_id, name, short_desc, directions, cat_name in all_clubs:
            search_corpus = f"{name} {short_desc or ''} {directions or ''} {cat_name or ''}".lower()
            words = [w.strip('.,«»"()[]!?') for w in search_corpus.split()]
            best_similarity = max((calc_word_similarity(q, w) for w in words if len(w) >= 3), default=0.0)
            if best_similarity >= 0.72:
                matched_clubs.append((club_id, name, short_desc))
    return matched_clubs

@dp.message(CommandStart())
async def start_handler(message: types.Message):
    await message.answer(
        "👋 Привет, друг! В этом боте ты сможешь найти всю информацию "
        "о внеучебных клубах НИУ ВШЭ – Нижний Новгород\n\n"
        "Выбери нужный раздел в меню ниже:",
        reply_markup=main_menu_keyboard
    )

@dp.message(Command("help"))
@dp.message(F.text == "ℹ️ О проекте и помощь") 
async def help_handler(message: types.Message):
    await message.answer(
        "ℹ️ О проекте «Внеучебка ВШЭ – Нижний Новгород»\n\n"
        "Этот бот создан студентами для студентов, чтобы собрать все 27 внеучебных клубов и объединений кампуса в одном месте 💙\n\n"
        "❓ Как пользоваться:\n"
        "• Каталог клубов — выбери направление (творчество, спорт, наука и др.) и найди клуб по душе.\n"
        "• Найти клуб — быстрый поиск по названию.\n"
        "• ⭐ Мои клубы — личный список сохранённых клубов для быстрого доступа.\n"
        "• 💙 Мини-приложение — интерактивный визуальный каталог с фото и атмосферой клубов.\n"
        "• ✍️ Идеи и правки — предложить новый клуб или сообщить об ошибке.\n\n"
        "🛠 Поддержка и обратная связь:\n"
        "Нашли баг, клуб сменил контакты или есть вопрос? Нажмите кнопку «✍️ Идеи и правки» в меню ниже — сообщение сразу уйдёт команде проекта!\n\n"
        "🌐 Сайт внеучебки: https://nnov.hse.ru/nnovstudents/about\n"
        "📢 Канал «активННик HSE»: https://t.me/aktivnnik"
    )

@dp.message(Command("app"))
@dp.message(F.text == "💙 Мини-приложение")
async def miniapp_handler(message: types.Message):
    if MINI_APP_URL:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🚀 Открыть мини-приложение", web_app=WebAppInfo(url=MINI_APP_URL))]
        ])
        await message.answer(
            "💙 **Визуальный каталог внеучебки (Mini App)**\n\n"
            "Нажми на кнопку ниже, чтобы открыть интерактивный каталог клубов с фотографиями прямо в Telegram:",
            reply_markup=keyboard,
            parse_mode="Markdown"
        )
    else:
        await message.answer(
            "💙 **Визуальный каталог внеучебки (Mini App)**\n\n"
            "Здесь будет открываться интерактивное приложение с каруселями фотографий и атмосферой клубов!\n\n"
            "*(Дизайн и верстка сейчас в разработке у команды)*",
            parse_mode="Markdown"
        )


@dp.message(F.text == "📂 Каталог клубов")
async def categories_handler(message: types.Message):
    categories = await get_categories()
    buttons = []
    for cat_id, cat_name in categories:
        buttons.append([
            InlineKeyboardButton(text=cat_name, callback_data=f"category_{cat_id}")
        ])
    buttons.append([
        InlineKeyboardButton(text="📋 Показать все клубы списком", callback_data="show_all_clubs")
    ])
    inline_keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer(
        "📂 Выбери категорию или посмотри все клубы сразу:",
        reply_markup=inline_keyboard
    )

@dp.callback_query(F.data.startswith("category_"))
async def category_click_handler(callback: types.CallbackQuery):
    await callback.answer()  
    category_id = int(callback.data.split("_")[1])
    category_name = await get_category_name(category_id)
    clubs = await get_clubs_by_category(category_id)
    buttons = []
    for club_id, club_name in clubs:
        buttons.append([
            InlineKeyboardButton(text=club_name, callback_data=f"club_{club_id}")
        ])
    buttons.append([
        InlineKeyboardButton(text="⬅️ Назад к категориям", callback_data="back_to_categories")
    ])
    if clubs:
        text = f"📂 Клубы направления **{category_name}** ({len(clubs)}):\n\nВыбери клуб, чтобы открыть карточку:"
    else:
        text = f"📂 В направлении **{category_name}** пока нет активных клубов."  
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await callback.message.edit_text(
        text,
        reply_markup=keyboard,
        parse_mode="Markdown"
    )

@dp.callback_query(F.data == "back_to_categories")
async def back_to_categories_handler(callback: types.CallbackQuery):
    await callback.answer()
    categories = await get_categories()
    
    buttons = []
    for cat_id, cat_name in categories:
        buttons.append([
            InlineKeyboardButton(text=cat_name, callback_data=f"category_{cat_id}")
        ])
    buttons.append([
        InlineKeyboardButton(text="📋 Показать все клубы списком", callback_data="show_all_clubs")
    ])
    
    inline_keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await callback.message.edit_text(
        "📂 Выбери категорию или посмотри все клубы сразу:",
        reply_markup=inline_keyboard
    )

@dp.callback_query(F.data == "show_all_clubs")
async def show_all_clubs_handler(callback: types.CallbackQuery):
    await callback.answer()
    clubs = await get_all_clubs()
    if not clubs:
        await callback.message.answer("Список клубов пока пуст.")
        return
    buttons = []
    for club_id, club_name in clubs:
        buttons.append([
            InlineKeyboardButton(text=club_name, callback_data=f"club_{club_id}")
        ])
    buttons.append([
        InlineKeyboardButton(text="⬅️ Назад к категориям", callback_data="back_to_categories")
    ])  
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await callback.message.edit_text("📋 Список всех клубов Вышки:", reply_markup=keyboard)

def build_club_keyboard(club_id, category_id, tg_url, vk_url, app_form_url, is_saved):
    card_buttons = []
    if app_form_url:
        card_buttons.append([
            InlineKeyboardButton(text="📝 Подать заявку", url=app_form_url)
        ])
    social_row = []
    if tg_url:
        social_row.append(InlineKeyboardButton(text="📢 Telegram", url=tg_url))
    if vk_url:
        social_row.append(InlineKeyboardButton(text="🌐 ВКонтакте", url=vk_url))
    if social_row:
        card_buttons.append(social_row)
    if is_saved:
        card_buttons.append([
            InlineKeyboardButton(text="❌ Удалить из Моих клубов", callback_data=f"toggle_club_{club_id}")
        ])
    else:
        card_buttons.append([
            InlineKeyboardButton(text="⭐ Сохранить в Мои клубы", callback_data=f"toggle_club_{club_id}")
        ])
    card_buttons.append([
        InlineKeyboardButton(text="⬅️ К направлению", callback_data=f"category_{category_id}"),
        InlineKeyboardButton(text="📋 Все клубы", callback_data="show_all_clubs")
    ])
    return InlineKeyboardMarkup(inline_keyboard=card_buttons)

@dp.callback_query(F.data.startswith("club_"))
async def club_click_handler(callback: types.CallbackQuery):
    await callback.answer()
    club_id = int(callback.data.split("_")[1])
    club = await get_club_by_id(club_id)
    if not club:
        await callback.message.answer("Информация о клубе не найдена.")
        return
    name, short_desc, full_desc, tg_url, curator, vk_url, category_id, app_form_url = club
    desc = full_desc if full_desc else short_desc
    clean_desc = re.sub(r'\n\s*\n+', '\n\n', desc.strip()).replace("* ", "• ").replace("_", "\\_")
    text = f"✨ **{name}**\n\n{clean_desc}\n"
    if app_form_url:
        text += f"\n📝 **Форма регистрации:** [заполнить анкету]({app_form_url})\n"
    if curator:
        clean_curator = curator.replace("_", "\\_")
        text += f"\n👤 Куратор: {clean_curator}"

    user_db_id = await get_or_create_user(callback.from_user)
    is_saved = await is_club_saved(user_db_id, club_id)
    keyboard = build_club_keyboard(club_id, category_id, tg_url, vk_url, app_form_url, is_saved)

    await callback.message.answer(
        text,
        reply_markup=keyboard,
        parse_mode="Markdown"
    )

@dp.callback_query(F.data.startswith("toggle_club_"))
async def toggle_club_handler(callback: types.CallbackQuery):
    club_id = int(callback.data.split("_")[2])
    user_db_id = await get_or_create_user(callback.from_user)
    is_saved = await is_club_saved(user_db_id, club_id)
    if is_saved:
        await remove_club_from_user(user_db_id, club_id)
        toast_text = "Клуб удалён из «Моих клубов»"
    else:
        await save_club_to_user(user_db_id, club_id)
        toast_text = "Клуб сохранён в «Мои клубы» ⭐"
    await callback.answer(toast_text)
    club = await get_club_by_id(club_id)
    if not club:
        return
    _, _, _, tg_url, _, vk_url, category_id, app_form_url = club
    new_keyboard = build_club_keyboard(club_id, category_id, tg_url, vk_url, app_form_url, not is_saved)
    await callback.message.edit_reply_markup(reply_markup=new_keyboard)



@dp.message(F.text == "🔍 Найти клуб")
async def search_handler(message: types.Message, state: FSMContext):
    await state.set_state(SearchClub.waiting_for_name)
    await message.answer(
        "🔍 **Поиск клубов**\n\n"
        "Введи название клуба или ключевое слово (например: *дебат*, *вокал*, *спорт*):",
        parse_mode="Markdown"
    )
@dp.message(StateFilter(SearchClub.waiting_for_name))
async def process_search_handler(message: types.Message, state: FSMContext):
    user_query = message.text.strip()
    await state.clear()
    clubs = await search_clubs_by_name(user_query)
    nav_buttons = [
        [
            InlineKeyboardButton(text="🔄 Искать снова", callback_data="start_search_again"),
            InlineKeyboardButton(text="📋 Все клубы", callback_data="show_all_clubs")
        ],
        [
            InlineKeyboardButton(text="🏠 Главное меню", callback_data="go_to_main_menu")
        ]
    ]
    if not clubs:
        await message.answer(
            f"По запросу «{user_query}» ничего не нашлось.\n\n"
            "Попробуй ввести другое слово или открой список всех клубов:",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=nav_buttons)
        )
        return
    buttons = []
    for club_id, club_name, _ in clubs:
        buttons.append([
            InlineKeyboardButton(text=club_name, callback_data=f"club_{club_id}")
        ])
    buttons.extend(nav_buttons)
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer(
        f"🎯 Найдено клубов: **{len(clubs)}**\n"
        "Нажми на клуб, чтобы открыть его карточку:",
        reply_markup=keyboard,
        parse_mode="Markdown"
    )
@dp.callback_query(F.data == "start_search_again")
async def search_again_handler(callback: types.CallbackQuery, state: FSMContext):
    await callback.answer()
    await state.set_state(SearchClub.waiting_for_name)
    await callback.message.answer(
        "🔍 **Новый поиск**\n\n"
        "Введи название клуба или ключевое слово (например: *дебат*, *вокал*, *спорт*):",
        parse_mode="Markdown"
    )
@dp.callback_query(F.data == "go_to_main_menu")
async def go_to_main_menu_handler(callback: types.CallbackQuery):
    await callback.answer()
    await callback.message.answer(
        "Главное меню:",
        reply_markup=main_menu_keyboard
    )


@dp.message(F.text.in_(["⭐ Мои клубы", "⭐ Мои подписки"]))
async def my_clubs_handler(message: types.Message):
    user_db_id = await get_or_create_user(message.from_user)
    clubs = await get_saved_clubs_by_user(user_db_id)
    if not clubs:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="📂 Открыть каталог клубов", callback_data="back_to_categories")]
        ])
        await message.answer(
            "⭐ **У тебя пока нет сохранённых клубов**\n\n"
            "Здесь будут отображаться клубы, которые ты добавишь в избранное.\n\n"
            "Чтобы сохранить клуб, открой его карточку в каталоге или поиске и нажми кнопку сохранения!",
            reply_markup=keyboard,
            parse_mode="Markdown"
        )
        return
    text = f"⭐ **Твои сохранённые клубы ({len(clubs)}):**\n\n"
    buttons = []
    for index, (club_id, club_name, tg_url, vk_url) in enumerate(clubs, start=1):
        links = []
        if tg_url:
            links.append(f"[Telegram]({tg_url})")
        if vk_url:
            links.append(f"[ВКонтакте]({vk_url})")
        links_text = " • ".join(links) if links else "контакты в карточке"

        text += f"{index}. **{club_name}**\n   🔗 {links_text}\n\n"
        buttons.append([
            InlineKeyboardButton(text=f"📌 {club_name}", callback_data=f"club_{club_id}"),
            InlineKeyboardButton(text="❌ Удалить", callback_data=f"remove_my_club_{club_id}")
        ])
    buttons.append([
        InlineKeyboardButton(text="📂 В каталог клубов", callback_data="back_to_categories")
    ])
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer(
        text,
        reply_markup=keyboard,
        parse_mode="Markdown",
        disable_web_page_preview=True
    )

@dp.callback_query(F.data.startswith("remove_my_club_"))
async def remove_my_club_handler(callback: types.CallbackQuery):
    club_id = int(callback.data.split("_")[3])
    user_db_id = await get_or_create_user(callback.from_user)
    await remove_club_from_user(user_db_id, club_id)
    await callback.answer("Клуб удалён из сохранённых")
    clubs = await get_saved_clubs_by_user(user_db_id)
    if not clubs:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="📂 Открыть каталог клубов", callback_data="back_to_categories")]
        ])
        await callback.message.edit_text(
            "⭐ **У тебя пока нет сохранённых клубов**\n\n"
            "Здесь будут отображаться клубы, которые ты добавишь в избранное.\n\n"
            "Чтобы сохранить клуб, открой его карточку в каталоге или поиске и нажми кнопку сохранения!",
            reply_markup=keyboard,
            parse_mode="Markdown"
        )
        return
    text = f"⭐ **Твои сохранённые клубы ({len(clubs)}):**\n\n"
    buttons = []
    for index, (c_id, club_name, tg_url, vk_url) in enumerate(clubs, start=1):
        links = []
        if tg_url:
            links.append(f"[Telegram]({tg_url})")
        if vk_url:
            links.append(f"[ВКонтакте]({vk_url})")
        links_text = " • ".join(links) if links else "контакты в карточке"

        text += f"{index}. **{club_name}**\n   🔗 {links_text}\n\n"
        buttons.append([
            InlineKeyboardButton(text=f"📌 {club_name}", callback_data=f"club_{c_id}"),
            InlineKeyboardButton(text="❌ Удалить", callback_data=f"remove_my_club_{c_id}")
        ])
    buttons.append([
        InlineKeyboardButton(text="📂 В каталог клубов", callback_data="back_to_categories")
    ])
    keyboard = InlineKeyboardMarkup(inline_keyboard=buttons)
    await callback.message.edit_text(
        text,
        reply_markup=keyboard,
        parse_mode="Markdown",
        disable_web_page_preview=True
    )


@dp.message(F.text.in_(["✍️ Идеи и правки", "✍️ Идеи и предложения"]))
async def suggest_handler(message: types.Message, state: FSMContext):
    await state.set_state(Feedback.waiting_for_text)
    cancel_keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="❌ Отмена", callback_data="cancel_feedback")]
    ])
    await message.answer(
        "✍️ **Идеи и правки**\n\n"
        "Напиши свою идею, правку по клубу или сообщение об ошибке одним сообщением.\n\n"
        "Мы передадим его напрямую команде проекта!",
        reply_markup=cancel_keyboard,
        parse_mode="Markdown"
    )

@dp.callback_query(F.data == "cancel_feedback")
async def cancel_feedback_handler(callback: types.CallbackQuery, state: FSMContext):
    await callback.answer()
    await state.clear()
    await callback.message.edit_text("Действие отменено.")
    await callback.message.answer(
        "Главное меню:",
        reply_markup=main_menu_keyboard
    )

@dp.message(StateFilter(Feedback.waiting_for_text))
async def process_feedback_handler(message: types.Message, state: FSMContext):
    user_text = message.text.strip()
    await state.clear()
    
    sender_name = message.from_user.full_name
    username = f"@{message.from_user.username}" if message.from_user.username else "нет username"
    user_id = message.from_user.id

    admin_message = (
        f"📬 **Новая идея или правка от студента!**\n\n"
        f"👤 **Отправитель:** {sender_name} ({username})\n"
        f"🆔 **ID:** `{user_id}`\n\n"
        f"📝 **Текст:**\n{user_text}"
    )

    if FEEDBACK_CHAT_ID:
        try:
            await bot.send_message(
                chat_id=FEEDBACK_CHAT_ID,
                text=admin_message,
                reply_markup=ReplyKeyboardRemove(),
                parse_mode="Markdown"
            )
        except Exception as e:
            print(f"Не удалось отправить сообщение модераторам: {e}")

    await message.answer(
        "💙 Спасибо за обратную связь! Мы передали твоё сообщение команде проекта.",
        reply_markup=main_menu_keyboard
    )


@dp.message()
async def unknown_message_handler(message: types.Message):
    await message.answer(
        "🤖Я пока не знаю такую команду\n\n"
        "Пожалуйста, выбери нужный раздел в меню ниже",
        reply_markup=main_menu_keyboard,
        parse_mode="Markdown"
    )

async def main():
    await bot.set_my_commands([
        BotCommand(command="start", description="Главное меню"),
        BotCommand(command="help", description="О проекте и помощь"),
        BotCommand(command="app", description="Открыть мини-приложение")
    ])
    print("Бот успешно запущен и слушает Telegram...")
    try:
        await dp.start_polling(bot)
    except (KeyboardInterrupt, SystemExit):
        print("Бот остановлен пользователем.")
    except Exception as error:
        print(f"Критическая ошибка: {error}")
        if FEEDBACK_CHAT_ID:
            try:
                await bot.send_message(
                    chat_id=FEEDBACK_CHAT_ID,
                    text=f"🚨 **Критический сбой бота!**\n\nПроцесс аварийно завершился с ошибкой:\n`{error}`",
                    parse_mode="Markdown"
                )
            except Exception as send_err:
                print(f"Не удалось отправить сообщение о сбое: {send_err}")
        raise error
    finally:
        await bot.session.close()

if __name__ == "__main__":
    asyncio.run(main())