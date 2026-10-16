import os
import re
import asyncio 
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart, Command, StateFilter
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, BotCommand
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
import aiosqlite
from difflib import SequenceMatcher

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())

main_menu_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [
            KeyboardButton(text="🔍 Найти клуб"),
            KeyboardButton(text="📂 Каталог клубов")
        ],
        [
            KeyboardButton(text="⭐ Мои подписки"),
            KeyboardButton(text="💙 Мини-приложение")
        ],
        [
            KeyboardButton(text="✍️ Идеи и предложения"),
            KeyboardButton(text="ℹ️ О проекте и помощь")
        ]
    ],
    resize_keyboard=True
)

DB_PATH = "hse_nn_clubs.db"
class SearchClub(StatesGroup):
    waiting_for_name = State()

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
        "Этот бот создан студентами для студентов, чтобы собрать все 30 внеучебных клубов и объединений кампуса в одном месте 💙\n\n"
        "❓ Как пользоваться:\n"
        "• Каталог клубов — выбери направление (творчество, спорт, наука и др.) и найди клуб по душе.\n"
        "• Найти клуб — быстрый поиск по названию.\n"
        "• Открыть мини приложение — интерактивный каталог с фото и атмосферой клубов.\n"
        "• Идеи и предложения — предложить новый клуб или исправление.\n\n"
        "🌐 Сайт внеучебки: https://nnov.hse.ru/nnovstudents/about\n"
        "📢 Канал «активННик HSE»: https://t.me/aktivnnik"
    )

@dp.message(Command("app"))
@dp.message(F.text == "💙 Мини-приложение")
async def miniapp_handler(message: types.Message):
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
    card_buttons = []
    if app_form_url:
        card_buttons.append([
            InlineKeyboardButton(text="📝 Подать заявку", url=app_form_url)
        ])
    social_row = []
    if tg_url:
        social_row.append(InlineKeyboardButton(text="⭐ Подписаться", url=tg_url))
    if vk_url:
        social_row.append(InlineKeyboardButton(text="🌐 ВК", url=vk_url))
    if social_row:
        card_buttons.append(social_row)
    card_buttons.append([
        InlineKeyboardButton(text="⬅️ К направлению", callback_data=f"category_{category_id}"),
        InlineKeyboardButton(text="📋 Все клубы", callback_data="show_all_clubs")
    ])
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=card_buttons)
    await callback.message.answer(
        text,
        reply_markup=keyboard,
        parse_mode="Markdown"
    )


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


@dp.message(F.text == "⭐ Мои подписки")
async def subscriptions_handler(message: types.Message):
    await message.answer("Твой список подписок пока пуст.")
@dp.message(F.text == "✍️ Идеи и предложения")
async def suggest_handler(message: types.Message):
    await message.answer("Здесь можно будет предложить новость или новый клуб.")

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
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())