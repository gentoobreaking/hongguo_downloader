#!/bin/bash
# 合併同一部劇的 ep-*.mp4 分段為單一 MP4（無損 concat，不重新編碼）
# 合併後自動驗證：大小 / 影音串流 / 解碼測試 / 時長一致性
#
# 注意：變數一律用 ${var} 寫法。若用 $p 直接接中文全形括號，在部分 locale 下
# bash 會把後面的高位元組當成變數名稱的一部分，報「unbound variable」。
set -euo pipefail
cd "$(dirname "$0")"   # 讓清單檔與輸出檔和 ep-*.mp4 同目錄
out="merged_video.mp4"

shopt -s nullglob      # 沒有符合檔時 files 為空陣列（否則會留下字面 "ep-*.mp4"）
files=(ep-*.mp4)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "找不到任何 ep-*.mp4 檔案" >&2
  exit 1
fi

# 自然排序（ep-2 排在 ep-10 前；ep-00N 補零命名其實字典序已正確，此為雙保險）
# /bin/bash 是 macOS 內建的 3.2，沒有 mapfile，用 while read 兼容
sorted=()
while IFS= read -r f; do
  sorted+=("$f")
done < <(printf '%s\n' "${files[@]}" | sort -V)
files=("${sorted[@]}")

echo "共找到 ${#files[@]} 個檔案，準備合併..."

# 參數一致性檢查：concat -c copy 要求各檔 codec/解析度相同，否則中途才報錯
profile=""
for f in "${files[@]}"; do
  p=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt -of csv=p=0 "${f}" 2>/dev/null || echo "?")
  if [[ -z "${profile}" ]]; then
    profile="${p}"
  elif [[ "${p}" != "${profile}" ]]; then
    echo "警告：${f} 的視訊參數（${p}）與第一個檔案（${profile}）不同，concat 複製可能失敗或不連續" >&2
  fi
done

# 產生 FFmpeg 清單檔（絕對路徑，從任何目錄執行都安全）
list_file="$(mktemp)"
trap 'rm -f "${list_file}"' EXIT
for f in "${files[@]}"; do
  printf "file '%s'\n" "$(pwd)/${f}" >> "${list_file}"
done

# 無損快速合併（-y 避免已存在時的互動卡住，</dev/null 雙保險）
echo "開始合併..."
if ! ffmpeg -v error -y -f concat -safe 0 -i "${list_file}" -c copy -movflags +faststart "${out}" </dev/null; then
  echo "錯誤：ffmpeg 合併失敗" >&2
  exit 1
fi

# ===== 合併後驗證 =====
echo ""
echo "=== 合併後檢查 ==="

# 1. 檢查檔案是否存在且大小 > 0
if [[ ! -f "${out}" ]]; then
  echo "❌ 錯誤：合併檔案不存在" >&2
  exit 1
fi

merged_size=$(stat -c%s "${out}" 2>/dev/null || stat -f%z "${out}" 2>/dev/null || echo 0)
if [[ ${merged_size} -eq 0 ]]; then
  echo "❌ 錯誤：合併檔案大小為 0" >&2
  exit 1
fi
echo "✅ 檔案存在，大小：$(numfmt --to=iec ${merged_size} 2>/dev/null || echo "${merged_size} bytes")"

# 2. 使用 ffprobe 檢查影音串流
echo "檢查影音串流..."
if ! ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 "${out}" >/dev/null 2>&1; then
  echo "❌ 錯誤：無法讀取影片串流" >&2
  exit 1
fi

if ! ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "${out}" >/dev/null 2>&1; then
  echo "❌ 錯誤：無法讀取音訊串流" >&2
  exit 1
fi
echo "✅ 影音串流正常"

# 3. 取得詳細資訊
video_info=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -of csv=p=0 "${out}" 2>/dev/null || echo "?")
audio_info=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "${out}" 2>/dev/null || echo "?")
duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${out}" 2>/dev/null || echo 0)

echo "📹 影片：${video_info}"
echo "🔊 音訊：${audio_info}"
printf "⏱️  總長度：%.2f 秒 (約 %d 分 %d 秒)\n" "${duration}" "$((${duration%.*}/60))" "$((${duration%.*}%60))"

# 4. 嘗試解碼前幾幀驗證無損壞
echo "解碼測試（前 5 幀）..."
if ! ffmpeg -v error -i "${out}" -frames:v 5 -f null - </dev/null 2>/dev/null; then
  echo "❌ 錯誤：影片解碼失敗（可能損壞）" >&2
  exit 1
fi
echo "✅ 影片解碼正常"

# 5. 檢查總時長是否合理（各檔案時長相加）
echo "檢查時長一致性..."
total_expected=0
for f in "${files[@]}"; do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}" 2>/dev/null || echo 0)
  total_expected=$(echo "${total_expected} + ${d}" | bc -l 2>/dev/null || awk "BEGIN {print ${total_expected} + ${d}}" || echo 0)
done
diff=$(echo "${duration} - ${total_expected}" | bc -l 2>/dev/null || awk "BEGIN {print ${duration} - ${total_expected}}" || echo 0)
# 允許 2 秒誤差（關鍵幀對齊等）
if (( $(echo "${diff#-} > 2" | bc -l 2>/dev/null || awk "BEGIN {print (${diff#-} > 2)}" || echo 0) )); then
  echo "⚠️  警告：合併時長 (${duration}s) 與預期 (${total_expected}s) 差異超過 2 秒"
else
  echo "✅ 時長一致（預期 ${total_expected}s，實際 ${duration}s）"
fi

echo ""
echo "🎉 合併完成並通過驗證：${out}"