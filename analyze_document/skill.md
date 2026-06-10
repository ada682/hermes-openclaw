---
name: analyze_document
description: Baca dan analisa isi file dokumen lokal (PDF, Word, Excel, TXT, CSV, MD) menggunakan AI natively via Qwen atau Kimi proxy. Lebih akurat dari ekstraksi manual. SELALU gunakan ini saat diminta membaca, merangkum, atau menganalisa isi file dokumen. JANGAN generate kode pymupdf/pdfplumber/python-docx untuk hal ini.
version: 1.0.0
---

# analyze_document

Skill ini membaca file dokumen dari disk lokal, mengirimnya ke AI proxy (Qwen atau Kimi), lalu mengembalikan analisis dari AI. Lebih akurat dari pymupdf/pdfplumber karena AI memahami struktur dan konteks dokumen, bukan hanya mengekstrak teks mentah.

## Kapan Pakai Skill Ini

- User minta "baca file ini", "cek isi dokumen", "ringkas PDF ini"
- User tanya sesuatu tentang isi file dokumen lokal
- User minta cari klausul, pasal, atau bagian tertentu di dokumen
- File berekstensi: `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.txt`, `.csv`, `.md`

## Kapan JANGAN Pakai

- File adalah gambar (`.jpg`, `.png`, `.gif`) → pakai vision tool
- File tidak ada di filesystem lokal

> PENTING: Jangan generate kode Python dengan pymupdf, pdfplumber, atau python-docx untuk membaca dokumen. Skill ini lebih akurat dan tidak butuh library tambahan.

## Environment Variables

| Variabel | Default | Keterangan |
|----------|---------|------------|
| `DOC_PROVIDER` | `qwen` | Provider default: `qwen` atau `kimi` |
| `QWEN_PROXY_URL` | `http://127.0.0.1:4891` | URL Qwen proxy |
| `QWEN_MODEL` | `qwen3.7-plus` | Model Qwen |
| `KIMI_PROXY_URL` | `http://127.0.0.1:4892` | URL Kimi proxy |
| `KIMI_MODEL` | `kimi-k2.6` | Model Kimi |

## Steps

1. Jalankan script via bash dengan parameter yang sesuai:

```bash
node {baseDir}/scripts/analyze_document.js \
  --file "<file_path_absolut>" \
  --question "<pertanyaan_tentang_dokumen>" \
  --provider <qwen|kimi|auto>
```

Contoh nyata:
```bash
node {baseDir}/scripts/analyze_document.js \
  --file "C:\Users\asus\Downloads\S&K_Autotrade.pdf" \
  --question "Ringkas isi dokumen ini" \
  --provider auto
```

2. Script akan output JSON ke stdout:
   - Sukses: `{ "result": "...", "file": "nama.pdf", "size_kb": 4, "provider": "Kimi", "model": "kimi-k2.6" }`
   - Error: `{ "error": "pesan error" }`

3. Sampaikan isi `result` ke user. Kalau ada `error`, sampaikan errornya dan saran perbaikannya.

## Pilih Provider

- **`auto`** (default) — ikut env `DOC_PROVIDER`, fallback ke `qwen`
- **`qwen`** — bagus untuk semua format, limit 20 MB
- **`kimi`** — lebih baik untuk PDF kompleks (tabel, grafik, scanned), limit 50 MB

## Troubleshooting

| Error | Solusi |
|-------|--------|
| `File tidak ditemukan` | Cek path, pastikan pakai path absolut |
| `Format tidak didukung` | Konversi file ke PDF atau TXT dulu |
| `File terlalu besar` | Coba provider lain atau kompres file |
| `Gagal koneksi ke proxy` | Pastikan Qwen/Kimi proxy sedang berjalan |
| `node: command not found` | Pastikan Node.js terinstall |