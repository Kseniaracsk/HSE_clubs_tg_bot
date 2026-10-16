import os
import asyncio 
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart, Command
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, BotCommand
import aiosqlite

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

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

async def get_categories():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id, name FROM categories ORDER by name") as cursor:
            return await cursor.fetchall()

async def get_category_name(category_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT name FROM categories WHERE id = ?", (category_id,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else "Категория"

async def get_club_by_id(club_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT name, short_description, telegram_channel_url, chairperson_contact FROM clubs WHERE id = ?",
            (club_id,)
        ) as cursor:
            return await cursor.fetchone() 

async def get_all_clubs():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id, name FROM clubs WHERE is_active = 1 ORDER BY name") as cursor:
            return await cursor.fetchall()


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
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="⬅️ Назад к категориям", callback_data="back_to_categories")]
    ])
    await callback.message.edit_text(
        f"📂 Ты выбрала категорию: **{category_name}**\n\n"
        "Скоро здесь покажем клубы этого направления!",
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
    name, short_desc, tg_url, curator = club
    text = f"✨ **{name}**\n\n{short_desc}\n"
    if curator:
        text += f"\n👤 Куратор: {curator}"
    card_buttons = []
    if tg_url:
        card_buttons.append([
            InlineKeyboardButton(text="📢 Перейти в Telegram-канал", url=tg_url)
        ])
    card_buttons.append([
        InlineKeyboardButton(text="⬅️ Назад ко всем клубам", callback_data="show_all_clubs")
    ])
    keyboard = InlineKeyboardMarkup(inline_keyboard=card_buttons)
    await callback.message.answer(text, reply_markup=keyboard, parse_mode="Markdown")

@dp.message(F.text == "🔍 Найти клуб")
async def search_handler(message: types.Message):
    await message.answer("Введи название клуба для поиска.")
@dp.message(F.text == "📋 Все клубы")
async def all_clubs_handler(message: types.Message):
    await message.answer("Здесь будет список всех 30 клубов.")
@dp.message(F.text == "💙 Мини-приложение")
async def miniapp_handler(message: types.Message):
    await message.answer("Здесь скоро будет кнопка запуска визуального каталога.")
@dp.message(F.text == "⭐ Мои подписки")
async def subscriptions_handler(message: types.Message):
    await message.answer("Твой список подписок пока пуст.")
@dp.message(F.text == "✍️ Идеи и предложения")
async def suggest_handler(message: types.Message):
    await message.answer("Здесь можно будет предложить новость или новый клуб.")


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