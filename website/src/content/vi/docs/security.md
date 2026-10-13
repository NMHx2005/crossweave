## Báo cáo lỗ hổng

**Đừng tạo issue công khai** để báo vấn đề bảo mật. Hãy dùng kênh báo cáo riêng của GitHub: **Security → Report a vulnerability** tại repository này (<https://github.com/NMHx2005/crossweave/security/advisories/new>). Gửi kèm điều bạn quan sát được, phiên bản (`cw --version`), hệ điều hành và các bước ngắn nhất để tái hiện. Bạn sẽ nhận phản hồi khi maintainer có thể đọc; đây là project cá nhân nhỏ nên không cam kết thời hạn phản hồi hay xử lý, nhưng lỗ hổng thật sẽ được xem xét nghiêm túc và sửa trước khi công bố.

Phiên bản được hỗ trợ: bản phát hành mới nhất. Các phiên bản cũ không còn nhận bản sửa.

## crossweave là gì và không phải là gì

crossweave là công cụ **ưu tiên chạy cục bộ**. Mọi thứ chạy trên máy của bạn:

- `cwd` (daemon) sở hữu `.crossweave/state.db` và chỉ lắng nghe **unix-domain socket** bên trong thư mục `.crossweave/` của repository. Nó không mở port mạng. (Điều khiển từ xa qua browser từng có đã bị gỡ; xem `docs/PROGRESS.md`.)
- Một session là git worktree cộng với **shell của chính bạn**. crossweave không chọn, cấu hình hay sandbox chương trình bạn chạy trong đó: tiến trình trong session có toàn bộ quyền của bạn. Port, cache và tên database mỗi session chỉ mang tính **hợp tác** — chúng được đưa vào biến môi trường, nhưng tiến trình bỏ qua vẫn có thể xung đột. Đây không phải ranh giới bảo mật; OS sandbox từng có đã bị gỡ (tag `v0.3-radar`).
- crossweave không gửi mã nguồn của bạn đi đâu. Chương trình kiểm tra GitHub Releases ở nền (dùng cache, nhiều nhất mỗi ngày một lần); tắt bằng `cw config update-check off`. Nó không tự cài bản cập nhật nếu bạn chưa chạy `cw update`.

## Mô hình tin cậy — dữ liệu nào được xem là không đáng tin

| Đầu vào | Được xem là | crossweave xử lý thế nào |
|---|---|---|
| `crossweave.config.json` của repository (`converge.testCommand`, hooks) | **Không đáng tin cho đến khi bạn cho phép** — file đến từ nơi bạn clone | Không chạy trước `cw config trust`; sửa lệnh hoặc hook sẽ yêu cầu tin cậy lại. `cw check` và `land` dùng cùng cổng kiểm tra |
| `~/.crossweave/settings.json` của bạn (launcher, preset, lệnh refine của composer) | **Do bạn quản lý** | Chạy đúng như đã ghi sau khi xác thực thành một dòng thuần, không qua shell (argv). Repository không thể thêm hoặc sửa chúng |
| Tiến trình truy cập unix socket của daemon | **Cùng người dùng, không xác thực** (tiến trình chạy với quyền của bạn) | Command bridge (`cw pane`, `cw browser`) và `cw notify` chỉ nhận các loại lệnh có trong danh sách đóng; quyết định do Cockpit (hoặc daemon) thực hiện, không tin caller. Thao tác ngoài việc sắp xếp pane hay hiện một dấu trạng thái sẽ hỏi bạn trước. Tiến trình cùng người dùng đăng ký vào bridge trước có thể trả lời hoặc giả mạo output — đây là giới hạn đã biết; muốn loại bỏ cần xác thực caller |
| Văn bản trang web tạo ra (console, network, `dom`, kết quả `eval`, ảnh chụp màn hình) | **Dữ liệu không đáng tin** — có thể chứa chỉ dẫn nhắm vào agent | Đánh dấu `"untrusted": true`; công tắc **Agent** theo pane mặc định tắt. Ảnh chụp màn hình, kết quả `dom` và `eval` không được che |
| Prompt gửi bằng composer | Văn bản, không phải phím bấm | Ký tự điều khiển (ví dụ escape có thể kết thúc bracketed paste sớm) bị loại bỏ; shell thường không bao giờ nhận quá một dòng |
| Đường dẫn lấy từ output session, file được thả vào, `cw pane open --file` | Đường dẫn không đáng tin | Được phân giải và giới hạn trong worktree của session (`assertContained`, kiểm tra từng symlink) |

## Những gì chủ ý nằm ngoài phạm vi

- Chương trình khác chạy dưới quyền người dùng của bạn (nó vốn đã có thể làm mọi thứ crossweave làm được).
- Agent độc hại mà bạn tự chọn chạy trong session (agent có quyền shell của bạn). Hãy xem xét kỹ quyền bạn giao cho agent, như khi không dùng crossweave.
- Ứng dụng được ký bằng chứng thư phát triển và **chưa notarize**; macOS có thể yêu cầu bạn cho phép ở lần mở đầu tiên.

Giới hạn còn lại của mỗi tính năng được ghi cạnh tài liệu thiết kế trong `docs/superpowers/specs/*-known-limitations.md`; bản tóm tắt một dòng nằm trong `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`.
