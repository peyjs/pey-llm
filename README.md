# pey.llm

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-1.0.2-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## هدف

افزونه‌ی ویژگی (feature) از زیست‌بوم پی برای تماس با فراهم‌کنندهٔ مدل زبانیِ سازگار با OpenAI: تنظیمات اتصال کاربر را در حافظه نگه می‌دارد (آدرس پایه، مدل، کلید اختیاری)، درخواست‌های کامل و جریانی را روی `pey.http` می‌سازد و خطاهای فراهم‌کننده را به کدهای ساخت‌یافتهٔ دسته‌بندی‌شده نگاشت می‌کند.

## ساختار

- `docs/` — سندهای پروژه.
- `lib/` — منطق سرویس و یاران پروتکل.
- `tests/` — آزمون‌های واحد.
- `index.js` — نقطه‌ی ورود.
- `manifest.json` — قرارداد افزونه.

## وابستگی‌ها

- **الزامی:** `pey.http.service` — تمام انتقال شبکه از این سرویس می‌گذرد.
- **اختیاری:** ندارد.

## نصب و استفاده

افزونه با `manifest.json` و بستهٔ npm به برنامه‌ی میزبان افزوده می‌شود و پس از دو فاز آماده‌سازی و فعال‌سازی، سرویس `pey.llm.service` را عرضه می‌کند. میزبان تنظیمات اتصال کاربر را با `setSettings` نگه می‌دارد و با `complete` و `stream` با مدل گفت‌وگو می‌کند؛ کلید هرگز از حافظهٔ افزونه بیرون نمی‌رود و پیکربندی مانیفست ندارد.

## مجوز

این پروژه با مجوز MIT منتشر شده است؛ متن کامل در [LICENSE](LICENSE).

## سندهای مرتبط

- [معرفی](docs/introduction.md) — شناخت افزونه به زبان ساده.
- [مرجع](docs/reference.md) — API، رویدادها، خطاها و پیکربندی.
- [نیازمندی‌ها](docs/requirements.md) — سند ساخت افزونه، مکتوب پیش از پیاده‌سازی.
