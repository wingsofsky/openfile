//! 原生端少量界面文字（系统对话框标题）的中英切换。
//! 界面语言只存在前端（localStorage），前端启动和每次切换语言时经 `set_locale` 告诉这里；缺省中文。
use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

/// 按当前语言取一句原生文字；中英两句写在调用处，像前端 t() 一样键就是中文
pub fn tr(zh: &'static str, en: &'static str) -> &'static str {
    if EN.load(Ordering::Relaxed) { en } else { zh }
}

#[tauri::command]
pub fn set_locale(locale: String) {
    EN.store(locale == "en", Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_language_last_set() {
        EN.store(false, Ordering::Relaxed);
        assert_eq!(tr("中", "en"), "中");
        EN.store(true, Ordering::Relaxed);
        assert_eq!(tr("中", "en"), "en");
        EN.store(false, Ordering::Relaxed);
    }
}
