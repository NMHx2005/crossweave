Một **session** là git worktree trên branch riêng cộng với shell của bạn, giống một cửa sổ tmux có branch riêng. Bạn tự gõ lệnh chạy trong shell: `claude`, `codex`, wrapper của bạn hoặc dev server. crossweave không chọn hay cấu hình agent; launcher bạn chọn sẽ gõ lệnh đã lưu vào shell rồi chạy.

## Thanh session

Cockpit liệt kê mọi project và session trên cùng một thanh. Mỗi hàng cho biết session đang làm gì: vòng tròn xoay khi agent đang chạy, dấu ✓ khi agent vừa xong và bạn chưa xem, màu hổ phách khi agent cần bạn trả lời, hoặc không có dấu khi shell đang nghỉ. Trạng thái được suy ra từ shell (nội dung trên màn hình, output, chuông và cây tiến trình), nên đáng tin với Claude Code, Codex và Gemini, còn với agent khác chỉ mang tính gần đúng. `cw hooks install claude` (hoặc `codex`) kết nối hook của agent đó với `cw notify`, giúp trạng thái chính xác ở nơi agent gửi tín hiệu.

## Cách ly

Mỗi session nhận một dải port riêng (`$PORT`), thư mục cache và tùy chọn tên database hoặc Docker riêng. Đây là các lease mang tính hợp tác: chúng được đưa vào môi trường của session, nhưng tiến trình bỏ qua chúng vẫn có thể xung đột với session khác.

## Land và bằng chứng

Daemon chạy trial merge nền giữa các session với branch gốc và với nhau. `cw land` chỉ cho phép land dựa trên bằng chứng đó; bằng chứng chỉ đúng với base commit được dùng lúc thử. Sau khi một session được land, các session còn lại chuyển sang trạng thái *unknown* cho đến lần thử tiếp theo. `cw converge status` cho biết lý do. Tùy chọn `converge.requireCheck` còn từ chối land khi session chưa có kết quả kiểm tra đạt còn hiệu lực với thay đổi hiện tại.

## Kiểm tra

`cw check` chạy lệnh test của project đã được tin cậy trong worktree của session rồi hiện kết quả trên thanh trạng thái. Lệnh lấy từ repository cần được tin cậy một lần bằng `cw config trust`; lệnh do bạn tự viết, như preset và launcher, không cần bước đó. Trong Cockpit bạn có thể bật chạy kiểm tra tự động khi agent kết thúc một lượt có thay đổi file; mặc định tính năng này tắt. Vì thời điểm kết thúc lượt được suy ra nên có thể có lần chạy bị bỏ sót hoặc chạy lặp.

## Checkpoint

Khi agent được nhận diện bắt đầu và kết thúc một lượt trong session có worktree riêng, crossweave ghi lại worktree thành git commit ẩn (`refs/crossweave/checkpoints/<session>/<n>`). `cw checkpoint list`, `diff` và `restore` đọc và dùng các bản ghi đó. Mặc định khôi phục chỉ chạy thử; khi áp dụng, crossweave tạo điểm quay lại trước rồi ghi/xóa file không bị ignore để khớp checkpoint. Thao tác từ chối trước khi sửa nếu sẽ ghi đè file bị ignore hoặc đi qua symlink. Checkpoint bỏ qua file bị ignore, có thể bị bỏ qua nếu snapshot quá lớn, hiện trong `git log --all` và `git push --mirror`, đồng thời chứa cả file không bị ignore như secret. Giữ lại 50 checkpoint mới nhất.

## Trùng lặp thay đổi

`cw overlap` và thanh trạng thái cho biết sớm những session khác đang sửa cùng file, trước khi trial merge phát hiện xung đột. Đây chỉ là tín hiệu cảnh báo, không chặn thao tác.
