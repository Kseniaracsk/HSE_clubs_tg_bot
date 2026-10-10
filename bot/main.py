import os
import asyncio 
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

main_menu_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [
            KeyboardButton(text="🔍 Найти клуб"),
            KeyboardButton(text="📂 Категории клубов")
        ],
        [
            KeyboardButton(text="📋 Все клубы"),
            KeyboardButton(text="💙 Открыть мини приложение")
        ],
        [
            KeyboardButton(text="⭐ Мои подписки"),
            KeyboardButton(text="✍️ Идеи и предложения")
        ]
    ],
    resize_keyboard=True
)

@dp.message(CommandStart())
async def start_handler(message: types.Message):
    await message.answer(
        "👋 Привет, друг! В этом боте ты сможешь найти всю информацию "
        "о внеучебных клубах НИУ ВШЭ – Нижний Новгород\n\n"
        "Выбери нужный раздел в меню ниже:",
        reply_markup=main_menu_keyboard
    )

@dp.message(F.text == "📂 Категории клубов")
async def categories_handler(message: types.Message):
    await message.answer("Раздел категорий: здесь будут 6 направлений клубов.")
@dp.message(F.text == "🔍 Найти клуб")
async def search_handler(message: types.Message):
    await message.answer("Введи название клуба для поиска.")
@dp.message(F.text == "📋 Все клубы")
async def all_clubs_handler(message: types.Message):
    await message.answer("Здесь будет список всех 30 клубов.")
@dp.message(F.text == "💙 Открыть мини приложение")
async def miniapp_handler(message: types.Message):
    await message.answer("Здесь скоро будет кнопка запуска визуального каталога.")
@dp.message(F.text == "⭐ Мои подписки")
async def subscriptions_handler(message: types.Message):
    await message.answer("Твой список подписок пока пуст.")
@dp.message(F.text == "✍️ Идеи и предложения")
async def suggest_handler(message: types.Message):
    await message.answer("Здесь можно будет предложить новость или новый клуб.")

async def main():
    print("🚀 Бот успешно запущен и слушает Telegram...")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())