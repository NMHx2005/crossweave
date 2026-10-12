```bash
cd your-project        # bất kỳ git repo nào
cw init                # tạo/kết nối workspace crossweave cho repo này
cw                     # mở cockpit (macOS) hoặc TUI

cw session new api      # worktree riêng trên branch cw/api
cw session new web      # worktree riêng trên branch cw/web
# Terminal 1: mở shell đầu tiên (Ctrl-] để tách khỏi shell)
cw session attach api
# Trong mỗi shell, chạy công cụ của bạn và tạo/commit thay đổi trong worktree đó
# Ở terminal thứ hai:
cw session attach web

cw session stop api    # đóng shell và tiến trình trong đó; worktree vẫn được giữ
cw session start api   # mở shell mới tại đó
```

Kiểm tra những thay đổi nào có thể merge, sau đó land phần không xung đột:

```bash
cw converge status      # ma trận xung đột từng cặp + thứ tự merge được đề xuất
cw land all             # land mọi session đã commit và không xung đột theo thứ tự đó
```

Mỗi session có branch và worktree riêng. Hãy commit những thay đổi muốn giữ ngay trong session trước khi land; `cw converge status` cho biết xung đột và đề xuất thứ tự, còn `cw land` vẫn tự trial merge. Nếu project đã tin cậy `converge.testCommand`, chạy `cw config trust` một lần rồi `cw check` trước khi land để xem kết quả trên hàng session. Muốn bắt buộc kiểm tra, đặt `"converge": { "testCommand": "…", "requireCheck": true }`: khi lần kiểm tra gần nhất chưa pass, `cw land` sẽ từ chối (`CHECK_REQUIRED`); `--skip-check` là cách bỏ qua tường minh. Khi session đang chạy, lệnh kiểm tra nhận các giá trị `$PORT`, cache và database riêng của session.

## Các lệnh dùng thường ngày

| Lệnh | Chức năng |
|---|---|
| `cw tui` | Bảng điều khiển trực tiếp — session, hội tụ và hoạt động |
| `cw session list` | Liệt kê session, branch và lease của chúng |
| `cw session path <name>` | Đường dẫn worktree của session (`cd $(cw session path alice)`) |
| `cw gc` | Thu gom worktree/branch của session đã kết thúc |
| `cw config notify off` | Tắt thông báo desktop (hoặc dùng `--event land\|convergence`) |
| `cw config trust` | Tin cậy `converge.testCommand` cho workspace này |
| `cw notify "tests written" [--kind done\|ask]` | Báo từ session (hoặc hook agent) rằng session đã xong hay cần bạn trả lời: hiện ✓ hoặc màu hổ phách trên hàng, đồng thời gửi nội dung vào thông báo |
| `cw check [session]` | Chạy `converge.testCommand` đã tin cậy trong worktree; trả mã 1 nếu lỗi; thanh trạng thái hiện `✓ tests` / `✗ tests` |
| `cw hooks install\|remove <claude\|codex> [--yes]` | Kết nối hoặc gỡ hook `Stop`/`Notification` của agent với `cw notify` để trạng thái chính xác. Cấu hình được gộp và sao lưu; file không đọc được sẽ không bị ghi đè. Gemini không có hệ thống hook tương thích |
| `cw debug [session] [--raw]` | Tạo gói văn bản gọn gồm phần log test lỗi gần nhất, lỗi trong terminal, diffstat và lời mới nhất của agent; secret được che theo heuristic (`--raw` tắt việc này). Dùng để gửi cho AI |
| `cw session history [--status landed\|dead] [--query text]` | Xem các session đã land hoặc xóa dù bản ghi session đã mất (tối đa 500 bản mới nhất) |
| `cw pane list\|split\|select\|zoom\|layout\|move\|sync\|close\|open` | Sắp xếp pane của cockpit đang chạy từ shell; ứng dụng hỏi trước khi đóng, đồng bộ hoặc mở trang/file |
| `cw browser list\|console\|network\|errors\|dom\|shot\|navigate\|click\|type\|eval` | Cho phép agent đọc và điều khiển Browser pane khi công tắc **Agent** bật (mặc định tắt); nội dung từ trang là dữ liệu không đáng tin |

Cây lệnh đầy đủ: `cw --help`; xem từng lệnh bằng `cw <command> --help`.
