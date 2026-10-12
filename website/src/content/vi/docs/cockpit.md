Để dùng hàng ngày, **crossweave Cockpit** là ứng dụng desktop Electron mỏng giao tiếp với `cwd`. Một thanh bên liệt kê các project đang mở và session của chúng; mỗi hàng cho biết trạng thái (đang chạy, đang chờ bạn, thất bại, đã đóng), lời mới nhất của agent, thời gian và agent nào đang chạy — tất cả đều suy ra từ shell của session, không cần cấu hình. Ứng dụng có thể mở độc lập từ Dock/Spotlight với màn hình chào mừng, hoặc mở đúng project bằng `cw`. Dấu trạng thái được giữ yên tĩnh có chủ ý: không có gì khi shell đang nghỉ, vòng tròn xoay khi agent làm việc, ✓ khi agent vừa xong mà bạn chưa xem, màu hổ phách khi agent hỏi bạn.

Nhấn ⌘T để chọn project và mở Terminal thường hoặc một trong các **launcher** của bạn — Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Copilot CLI, Aider, Amp, Qwen Code hay lệnh riêng như `cx`. Launcher chưa cài được làm mờ; lệnh và môi trường của từng launcher chỉnh trong Settings (⌘,). Shell mở tại thư mục project hoặc trong worktree riêng của session; dòng lệnh launcher được gõ vào đó. Dùng ⌘D / ⌘⇧D để chia pane, ⌘W để đóng pane, ⌘1…⌘9 để chuyển đến session trên thanh bên. Tab có thể chứa shell, file, trang web và Changes pane (diff sẽ được đưa vào nếu land). Session sẵn sàng có nút Land; mỗi hàng cũng cho biết file chưa commit và commit đang chờ land.

Nhấp chuột phải vào project để đổi tên (chỉ trong ứng dụng), màu, thứ tự, đóng project, mở trong Finder/editor, mở terminal trong thư mục đó, land mọi session sẵn sàng, dọn session đã kết thúc hoặc đặt mặc định. Với session, menu tương tự cho phép thao tác thư mục và đổi tên; cũng có thể nhấp đúp để đổi tên. Bộ lọc thu hẹp danh sách; Dock đếm session đang chờ bạn.

Các công cụ khác gồm **prompt composer** (⌘⇧P) để viết một prompt, tùy chọn tinh chỉnh bằng chương trình do bạn chọn (Settings → Prompt), rồi gửi tới một hay nhiều session; **Compare with another…** để đặt thay đổi hai session cạnh nhau và land phần tốt hơn; **preset** (Settings → Presets, sau đó ⌘T) khởi chạy session, terminal dev và browser dùng port của session chỉ với một thao tác; **Run checks** và lịch sử session (⌘⇧H); **Debug pane** theo session để xem phần log lỗi, lỗi console/request của Browser pane, diff và soạn nội dung gửi vào composer để bạn xác nhận; cùng **Responses** (⌘⇧R) liệt kê session nhận prompt gần nhất, trạng thái, lời mới nhất và kết quả kiểm tra.

Trang **Settings** kiểu Cursor có **Dashboard** (project, session, dung lượng worktree, bộ nhớ và đề xuất dừng/xóa mục nhàn rỗi — không thao tác nào diễn ra nếu bạn chưa xác nhận); pane kiểu tmux (`Ctrl-A` rồi nhấn phím, đồng bộ, copy mode, tùy chọn lưu trạng thái terminal); và công tắc **Agent** riêng cho từng pane (Off / Read / Control) của `cw browser`. Cockpit dùng cùng daemon và cổng bằng chứng với CLI; ứng dụng không tự khởi chạy tiến trình.

![Prompt composer: một prompt và checkbox từng session để chọn nơi gửi](docs/images/cockpit-composer.png)

![Dashboard: session, dung lượng worktree và bộ nhớ theo project](docs/images/cockpit-dashboard.png)

Trên macOS arm64, trình cài đặt tiêu chuẩn cài Cockpit nếu release có gói ứng dụng; chạy `cw` sẽ mở nó cho repository hiện tại. Nếu ứng dụng chưa có hoặc không mở được, `cw` chuyển sang TUI; `cw tui` luôn mở bảng điều khiển terminal.

| | |
|---|---|
| Nền tảng v1 | Chỉ macOS arm64 (`macOS-only-v1`) |
| Cockpit trên Windows / Linux | Để sau khi `cwd` chạy được trên các hệ điều hành đó |
| Thiết kế | `docs/superpowers/specs/2026-09-17-cockpit-design-system.md` — một lớp token (`apps/cockpit/src/ui/tokens.ts`) dùng chung cho chrome và pane |
| Phát triển | `cd apps/cockpit && bun install && bun run dev` |
| Đóng gói | `cd apps/cockpit && bun run dist:mac` — xem `apps/cockpit/README.md` |
| Thiết kế | `docs/superpowers/specs/2026-09-16-cockpit-electron-design.md` |
