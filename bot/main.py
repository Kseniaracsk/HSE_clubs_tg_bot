import os
import asyncio 
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types
from aiogram.filters import CommandStart

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

@dp.message(CommandStart())
async def start_handler(message: types.Message):
    await message.answer(
        "👋 Привет! Я бот внеучебки НИУ ВШЭ – Нижний Новгород.\n\n"
        "Скоро здесь будет удобный поиск по всем 30 клубам и красивый каталог!"
    )

async def main():
    print("🚀 Бот успешно запущен и слушает Telegram...")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())