import { en } from './en'
import type { Content, Feature } from './types'

const badge = (tag: string): string => `Có trong bản phát hành tới (${tag})`
const more = 'Giới hạn và chi tiết'

// Sources and `since` are facts about the repository, not words: they are taken from the English entries so the two languages cannot disagree.
const base = (id: string): Pick<Feature, 'source' | 'source2' | 'since'> => {
  const f = en.home.features.items.find((item) => item.id === id)
  if (f === undefined) throw new Error(`no English feature ${id}`)
  return { source: f.source, ...(f.source2 === undefined ? {} : { source2: f.source2 }), since: f.since }
}

const features: Feature[] = [
  {
    id: 'sessions',
    title: 'Một session là một worktree cộng với shell của bạn',
    text: 'Mỗi session có branch riêng, một dải port ($PORT), thư mục cache và tên database hoặc Docker tuỳ chọn. Gõ gì trong shell — claude, codex, một dev server — là việc của bạn.',
    qualifier: 'Các lease chỉ mang tính hợp tác: một tiến trình phớt lờ chúng vẫn có thể đụng độ với session khác.',
    ...base('sessions'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'rail',
    title: 'Một thanh bên, trạng thái trung thực',
    text: 'Mọi session nằm trên một danh sách và cho biết nó đang chạy, đang chờ bạn, đã xong hay thất bại — suy ra từ chính shell, không cần cấu hình gì.',
    qualifier: 'Suy ra từ chữ trên màn hình, output và cây tiến trình: đáng tin với Claude Code, Codex và Gemini, chỉ gần đúng với các agent khác. cw hooks install claude (hoặc codex) làm chúng chính xác ở những chỗ agent báo cáo.',
    ...base('rail'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'checkpoints',
    title: 'Một checkpoint quanh các lượt của agent',
    text: 'Khi một agent được nhận diện bắt đầu và kết thúc một lượt, crossweave ghi worktree thành một commit git ẩn. Xem lượt đó đã đổi gì, hoặc lấy lại các file; khôi phục luôn chạy thử trước và để lại một điểm quay về.',
    qualifier: 'Cần session có worktree riêng và một agent được nhận diện; ranh giới lượt là suy đoán và một checkpoint tự động có thể bị bỏ qua; file bị ignore không được ghi; giữ 50 checkpoint mới nhất. Checkpoint là đối tượng git trong repository của bạn, thấy được bằng git log --all và git push --mirror, và chứa cả file không bị ignore như secret.',
    ...base('checkpoints'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'comments',
    title: 'Comment trên diff, dán vào shell',
    text: 'Bấm vào một dòng trong ngăn Changes hoặc một checkpoint, viết ghi chú, và các ghi chú được dán vào shell của session thành một khối. Không có gì tự bấm Enter thay bạn.',
    qualifier: 'Comment chỉ nằm trong bộ nhớ, và một shell thường không có agent sẽ bị từ chối.',
    ...base('comments'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'auto-check',
    title: 'Chạy test sau mỗi lượt, nếu bạn muốn',
    text: 'Bật lên thì lệnh test bạn đã tin cậy sẽ chạy khi một agent kết thúc lượt có đổi file. Khi lỗi, có thể gửi vào shell (đã che secret) và có thông báo desktop không bao giờ hiện output.',
    qualifier: 'Mặc định tắt. Việc một lượt kết thúc là suy đoán nên một lần chạy có thể bị bỏ sót hoặc lặp lại. Nó chạy code agent vừa viết, ngoài mọi sandbox, cho mọi project bạn đã tin cậy lệnh; thông báo đến từ cửa sổ đang mở nên chỉ project nó đang mở mới báo.',
    ...base('auto-check'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'sensitive',
    title: 'Nhìn kỹ hơn những file rủi ro',
    text: 'File có tên giống secret, cấu hình CI và hook, migration và manifest dependency mang một nhãn trong Changes, Checkpoints và Compare, và nút Land của Cockpit hỏi trước với file giống secret và file automation.',
    qualifier: 'Chỉ dựa vào tên file: có thể bỏ sót một key dán vào file thường và gắn nhãn nhầm file vô hại. cw land và Land all ready không hỏi, và câu hỏi bị bỏ qua nếu không đọc được diff.',
    ...base('sensitive'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'land',
    title: 'Land cái đứng vững',
    text: 'Các trial merge chạy nền cho biết session nào merge không xung đột và theo thứ tự nào, và cw land dựa trên bằng chứng đó.',
    qualifier: 'Bằng chứng chỉ có giá trị với base commit mà nó được thử, nên sau một lần land các session còn lại hiện unknown cho đến khi được thử lại. Nó cho thấy xung đột chứ không đảm bảo đúng đắn, và --force có thể land khi bằng chứng chưa đủ.',
    ...base('land'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'compare',
    title: 'So sánh hai session',
    text: 'Thay đổi đã commit của hai session cạnh nhau, các file chung được đánh dấu, kèm kết quả test mỗi bên và nút Land riêng.',
    qualifier: 'Chỉ công việc đã commit, và hai session cùng đụng một file không có nghĩa là xung đột.',
    ...base('compare'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'composer',
    title: 'Một prompt, nhiều session',
    text: 'Viết prompt một lần, tuỳ chọn tinh chỉnh bằng chương trình bạn đặt tên, rồi gửi cho một hoặc nhiều session với bản xem trước chính xác. Chỉ bấm Enter khi bạn tick chọn.',
    qualifier: 'Việc một session có chạy agent hay không chỉ là đoán; bản nháp chỉ nằm trong bộ nhớ.',
    ...base('composer'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'debug',
    title: 'Vì sao lỗi, ở một chỗ',
    text: 'Ngăn Debug gom phần cuối log test lỗi, các dòng lỗi, lỗi console của các ngăn trình duyệt và diff, rồi soạn sẵn để bạn gửi. cw debug in một bộ tương tự (kết quả check, lỗi của terminal, diffstat và những lời cuối của agent) để bạn dán cho một AI.',
    qualifier: 'Nhận diện dòng lỗi và che secret chỉ là heuristic, không phải đảm bảo.',
    ...base('debug'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'browser',
    title: 'Cho agent dùng một ngăn trình duyệt, theo điều kiện của bạn',
    text: 'cw browser đọc và điều khiển một ngăn Browser sau công tắc Off, Read hoặc Control cho từng ngăn. Mặc định Off; điều khiển ngoài localhost, và chạy một đoạn script ở bất cứ đâu, đều hỏi bạn cho từng lệnh.',
    qualifier: 'Chữ trên trang có thể mang chỉ thị độc hại và được đánh dấu là không tin cậy; công tắc theo từng ngăn và không bao giờ được nhớ.',
    ...base('browser'),
    linkLabel: more,
    nextBadge: badge,
  },
  {
    id: 'presets',
    title: 'Công thức session một cú bấm',
    text: 'Một preset khởi động session với launcher của nó, các terminal phụ mỗi cái chạy một lệnh, và một ngăn Browser trên port của session.',
    qualifier: 'Các lệnh nằm trong file settings của riêng bạn, và không có gì chờ server sẵn sàng.',
    ...base('presets'),
    linkLabel: more,
    nextBadge: badge,
  },
]

export const vi: Content = {
  lang: 'vi',
  htmlLang: 'vi',
  siteName: 'crossweave',
  nav: {
    skip: 'Đến phần nội dung',
    download: 'Tải về',
    docs: 'Tài liệu',
    changelog: 'Lịch sử thay đổi',
    github: 'GitHub',
    switchTo: 'English',
    switchLabel: 'Chuyển sang tiếng Anh',
  },
  home: {
    title: 'crossweave — chạy nhiều agent lập trình trên một repo',
    description:
      'Mỗi session là một git worktree cộng với shell của bạn. Xem ai đang chạy, đang hỏi hay đã xong, trial merge chạy nền, và land cái đứng vững. Miễn phí, MIT, macOS và Linux.',
    hero: {
      headline: 'Nhiều agent. Một repo. Land cái đứng vững.',
      subtitle:
        'crossweave cho mỗi agent lập trình một git worktree và một shell riêng, cho bạn thấy cái nào đang chạy, đang hỏi hay đã xong, và trial merge chạy nền để bạn land cái đứng vững.',
      downloadCta: 'Tải cho macOS',
      installCta: 'Cài CLI',
      githubCta: 'Xem trên GitHub',
      installNote: 'macOS (arm64, x64) và Linux (x64). Cài cw và cwd vào ~/.local/bin và, trên Apple Silicon, cả ứng dụng Cockpit.',
      shotAlt: 'crossweave Cockpit: thanh bên các session ở bên trái — một cái đang chạy, một cái đang hỏi, một cái đã xong — và hai ngăn agent cạnh nhau',
      versionLine: (v) => `Bản phát hành mới nhất ${v} · giấy phép MIT · miễn phí`,
    },
    features: {
      title: 'Vòng lặp phát triển của bạn',
      intro: 'Mọi thứ dưới đây đều kết thúc bằng chữ được gõ vào shell của chính bạn. crossweave chứa shell; bạn chạy các agent.',
      items: features,
    },
    agents: {
      title: 'Dùng được với các agent bạn đang chạy',
      text: 'Một session mới có thể khởi động bằng một launcher — hoặc chỉ là một shell.',
      names: [...en.home.agents.names],
      note: 'Hoặc wrapper của riêng bạn (cx, một script, một dev server). crossweave không chọn hay cấu hình agent: một launcher gõ lệnh bạn đã lưu vào shell của session rồi chạy nó, và bạn cũng có thể bắt đầu bằng một shell thường.',
    },
    not: {
      title: 'Những điều nó cố ý không làm',
      intro: 'Mỗi điều dưới đây từng được làm hoặc cân nhắc rồi cố ý bỏ ra.',
      items: [
        { title: 'Không có mô hình agent', text: 'Không có bộ chọn AI thay bạn, không có adapter cho agent và không có cờ khởi chạy riêng cho từng agent (bạn tự sửa lệnh của launcher). Phiên bản cuối còn chúng là v0.3-radar.' },
        {
          title: 'Không có chốt chặn va chạm hay sandbox',
          text: 'Collision Radar, Safe Mode và sandbox của hệ điều hành đã bị gỡ. Cảnh báo duy nhất còn lại là tín hiệu trùng file, chỉ khuyên và không bao giờ chặn.',
        },
        {
          title: 'Không điều khiển từ xa qua trình duyệt',
          text: 'Trang web trên điện thoại và cw gateway đã bị gỡ (v0.4-remote-web). Một ứng dụng iOS thuần cho điều khiển từ xa đang được dự định, thiết kế lại từ đầu.',
        },
        { title: 'Không đọc chính tả trong app', text: 'Đọc chính tả dùng công cụ chuyên dụng trên toàn hệ thống thì tốt hơn (phiên bản cuối còn nó: v0.5-voice-input).' },
        {
          title: 'Không có Windows',
          text: 'Daemon dùng pty và unix socket của Bun, nên chỉ macOS và Linux; Cockpit chạy trên macOS Apple Silicon.',
        },
      ],
    },
    compare: {
      title: 'Sao không chỉ dùng git worktree và tmux?',
      caption: 'Làm tay so với crossweave',
      headings: ['', 'Làm tay (git worktree + tmux)', 'crossweave'],
      rows: [
        ['Một branch và một bản checkout cho mỗi agent', 'Bạn tự tạo và xoá từng worktree.', 'cw session new tạo worktree và branch; cw gc thu hồi những gì đã kết thúc.'],
        [
          'Port, cache, database',
          'Tuỳ bạn nhớ mà đặt.',
          'Mỗi session một dải port, một thư mục cache và tên database hoặc Docker tuỳ chọn (mang tính hợp tác, không ép buộc).',
        ],
        ['Ai đang cần bạn', 'Lật qua từng cửa sổ.', 'Một thanh bên: đang chạy, đang hỏi, đã xong hoặc thất bại.'],
        ['Land sẽ mang gì vào', 'git diff, từng branch một.', 'Diff của từng session so với chỗ nó rời base, cộng trial merge chạy nền.'],
        ['Merge cái nào trước', 'Tuỳ phán đoán của bạn.', 'Thứ tự đề xuất từ các trial merge.'],
        ['Bản ghi từng lượt của agent', 'Reflog, nếu bạn có commit.', 'Mỗi lượt một checkpoint để xem và khôi phục.'],
        ['Chọn agent', 'Bạn.', 'Vẫn là bạn: launcher chỉ gõ lệnh bạn đã lưu.'],
      ],
      foot: 'crossweave thêm một daemon và một ứng dụng vào quy trình trên; nếu bạn chỉ chạy hai agent, worktree thường là đủ.',
    },
    why: {
      title: 'Vì sao là “crossweave”?',
      text: 'Các agent của bạn chạy như những sợi dọc song song. crossweave là sợi ngang: sợi chéo buộc chúng lại để tấm vải đứng vững.',
    },
    faq: {
      title: 'Câu hỏi thường gặp',
      items: [
        {
          q: 'crossweave là gì?',
          a: 'Một công cụ ưu tiên chạy cục bộ để chạy nhiều session trên một repository rồi land chúng về. Một session là một git worktree cộng một shell trong đó, như một cửa sổ tmux có branch riêng. Một daemon chạy nền (cwd) lo phần sổ sách; cw, một dashboard terminal và ứng dụng Cockpit nói chuyện với nó.',
        },
        {
          q: 'Nó có phải IDE hay editor không?',
          a: 'Không. Nó có ngăn xem file gọn nhẹ và ngăn diff, nhưng không cố thay editor của bạn. Cmd+click mở file trong editor bạn chọn.',
        },
        {
          q: 'Nó dùng được với những agent nào?',
          a: 'Bất cứ thứ gì bạn chạy được trong shell. Có launcher cho Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Copilot CLI, Aider, Amp và Qwen Code, và bạn thêm được launcher riêng. Dấu hiệu trạng thái đáng tin nhất với Claude Code, Codex và Gemini.',
        },
        {
          q: 'Nó có chọn agent thay tôi không?',
          a: 'Không. Bạn chọn một launcher, hoặc một shell thường, và tự sửa lệnh của từng launcher trong Settings. Khởi động session bằng launcher sẽ gõ lệnh đã lưu đó vào shell và chạy nó. crossweave không chọn, không cấu hình và không giám sát agent.',
        },
        {
          q: 'Code của tôi đi đâu?',
          a: 'Bản thân crossweave không gửi gì đi đâu và không có telemetry: một daemon cục bộ sau một unix socket. Nó chỉ dùng mạng khi installer tải về, khi cw update, và khi kiểm tra bản mới tuỳ chọn với GitHub. Lệnh Refine là chương trình bạn đặt tên, còn các agent bạn chạy và các trang bạn mở có hành vi mạng riêng của chúng.',
        },
        {
          q: 'Chạy được trên nền tảng nào?',
          a: 'CLI, daemon và dashboard terminal chạy trên macOS (Apple Silicon và Intel) và Linux (x64). Ứng dụng Cockpit chạy trên macOS Apple Silicon. Windows không phải mục tiêu.',
        },
        { q: 'Giá bao nhiêu và giấy phép gì?', a: 'Miễn phí và mã nguồn mở theo giấy phép MIT.' },
        {
          q: 'Vì sao ứng dụng chưa được notarize?',
          a: 'Notarize cần tài khoản Apple Developer trả phí, mà tác giả chưa có. Vì vậy tải ứng dụng bằng trình duyệt sẽ gặp cảnh báo của macOS; đường cài bằng installer và các bước thủ công ở trang Tải về tránh hoặc gỡ được cảnh báo đó.',
        },
        {
          q: 'Cập nhật thế nào?',
          a: 'Chạy cw update. cw cũng tự kiểm tra bản mới ở nền (kết quả được lưu trong một ngày) và báo cho bạn khi có; cw config update-check off tắt việc đó.',
        },
        {
          q: 'Test tự động có tự chạy không?',
          a: 'Chỉ khi bạn bật (Settings → Checks, mặc định tắt) và chỉ với lệnh test bạn đã tin cậy bằng cw config trust. Nó chạy code agent vừa viết, ngoài mọi sandbox.',
        },
        {
          q: 'Gỡ cài đặt thế nào?',
          a: 'Trước hết land hoặc giữ lại phần việc bạn cần, và gỡ các hook agent đã cài bằng cw hooks remove claude hoặc cw hooks remove codex. Xoá các session không còn cần bằng cw session rm TÊN --yes (session phải đã kết thúc) hoặc cw gc; việc đó cũng xoá checkpoint của chúng. Cuối cùng, thoát ứng dụng, chạy cw daemon stop trong từng project, rồi xoá cw và cwd khỏi ~/.local/bin, ứng dụng khỏi ~/Applications, thư mục .crossweave của từng project, và settings của bạn trong ~/.crossweave.',
        },
      ],
    },
    cta: {
      title: 'Thử trên một repository bạn dám mang ra thí nghiệm',
      text: 'Hai worktree, hai shell, một thanh bên. Làm theo phần bắt đầu nhanh.',
    },
  },
  download: {
    title: 'Tải crossweave',
    description: 'Tải crossweave Cockpit cho macOS hoặc cài CLI trên macOS và Linux. Miễn phí, MIT.',
    headline: 'Tải crossweave',
    intro: 'Bản phát hành mới nhất: phiên bản bên dưới. Mọi file đều có checksum; installer tự kiểm tra giúp bạn.',
    cockpit: {
      title: 'Cockpit cho macOS (Apple Silicon)',
      text: 'Ứng dụng desktop. Ảnh đĩa là cách cài kéo-vào-Applications quen thuộc; file zip là cùng ứng dụng đó.',
      dmg: 'Tải .dmg',
      zip: 'Tải .zip',
    },
    cli: {
      title: 'Cài CLI (và ứng dụng)',
      text: 'Một dòng lệnh cài cw và cwd, kiểm tra checksum và, trên Apple Silicon, cài luôn Cockpit. Không dùng sudo và không sửa shell profile của bạn.',
      installLine: en.download.cli.installLine,
      manual:
        'Muốn tự làm? Tải cw-<platform>, cwd-<platform> và checksums.txt từ bản phát hành, chỉ kiểm tra hai file đó (grep -E " (cw|cwd)-<platform>$" checksums.txt | shasum -a 256 -c -, hoặc sha256sum -c - trên Linux), rồi chmod +x và đưa chúng vào PATH với tên cw và cwd.',
      requires:
        'Installer cần curl, một shell POSIX, awk, sha256sum hoặc shasum, và unzip (cho ứng dụng, chỉ được cài khi bản phát hành có nó và máy là Apple Silicon). Bản thân crossweave cần git. Các binary đã biên dịch không cần Bun.',
    },
    notNotarized: {
      title: 'Chưa được notarize',
      text: 'Ứng dụng được ký bằng chứng chỉ phát triển nhưng chưa được Apple notarize. Ảnh đĩa hoặc file zip tải bằng trình duyệt thường bị đánh dấu là tải từ internet, và macOS sẽ từ chối mở ứng dụng chưa notarize mang dấu đó. File tải bằng curl thường không bị đánh dấu, và installer dùng curl.',
      commandNote: 'Nếu bạn đã kéo ứng dụng vào Applications và macOS từ chối, hãy xoá dấu đó một lần:',
      installerNote:
        'Installer tải và kiểm tra checksum cw và cwd vào ~/.local/bin và, trên Apple Silicon, giải nén Cockpit vào ~/Applications. Nó không cài file .dmg, không xoá dấu nào và không dùng sudo.',
    },
    notarized: { title: 'Đã được Apple notarize', text: 'Bản này đã được notarize: mở như mọi ứng dụng khác.' },
    checksums: 'checksums.txt',
    older: 'Mọi bản phát hành và checksum',
  },
  footer: {
    tagline: 'Chạy nhiều agent trên một repo. Land cái đứng vững.',
    license: 'Giấy phép MIT',
    issues: 'Issues',
    version: (v) => `Bản phát hành ${v}`,
  },
  docsNotice: 'Tài liệu và lịch sử thay đổi bằng tiếng Anh.',
  notFound: { title: 'Không tìm thấy trang', text: 'Trang này không tồn tại.', home: 'Về trang chủ' },
}
