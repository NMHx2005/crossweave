```bash
curl -fsSL https://raw.githubusercontent.com/NMHx2005/crossweave/main/install.sh | sh
```

Cài `cw`/`cwd` vào `~/.local/bin` trên macOS (arm64/x64) và Linux (x64). Trên macOS arm64, nếu bản phát hành có gói Cockpit thì trình cài đặt cũng đưa ứng dụng vào `~/Applications/crossweave Cockpit.app` (trình cài đặt vẫn dùng được với các bản cũ chưa có ứng dụng). Mọi tệp tải về đều được xác minh checksum; trình cài đặt không dùng `sudo` và không sửa các file cấu hình shell.

`cw` kiểm tra phiên bản mới ở nền (lưu kết quả, tối đa mỗi ngày một lần) và báo khi có bản mới để bạn chạy `cw update`; chương trình không tự cài đặt nếu bạn chưa chạy lệnh đó. Tắt kiểm tra bằng `cw config update-check off`.

## Từ mã nguồn (để phát triển chính crossweave)

```bash
git clone https://github.com/NMHx2005/crossweave crossweave
cd crossweave
bun install
bun run scripts/build.ts   # tạo dist/cw và dist/cwd
```

## Gỡ cài đặt

Thực hiện theo thứ tự này để không còn tiến trình đang chạy hoặc phần cài đặt bị dở:

1. Land hoặc giữ lại mọi thay đổi bạn cần từ các session.
2. Gỡ các hook agent đã cài: `cw hooks remove claude` và `cw hooks remove codex`.
3. Dừng các session không cần nữa (`cw session stop NAME`), rồi xóa bằng `cw session rm NAME --yes`, hoặc thu gom session đã kết thúc bằng `cw gc`. Lệnh này giữ lại session còn công việc chưa land. Xóa session cũng xóa worktree và branch của nó.
4. Thoát Cockpit, rồi dừng daemon của từng project bằng `cw daemon stop` trong project đó.
5. Xóa `cw` và `cwd` khỏi `~/.local/bin`, ứng dụng khỏi `~/Applications` (hoặc `/Applications`), thư mục `.crossweave` của từng project, và cài đặt tại `~/.crossweave`.
