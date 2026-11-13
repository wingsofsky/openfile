fn main() {
    // Build-time only, never from the GUI thread. Node is already required by the frontend.
    for path in ["../packages/runtime/src", "../packages/protocol/src", "../packages/runtime/scripts/build.mjs"] {
        println!("cargo:rerun-if-changed={path}");
    }
    let status = std::process::Command::new("node")
        .args(["../packages/runtime/scripts/build.mjs", "--desktop-cli"])
        .status().expect("Node.js is required to bundle the desktop resources");
    assert!(status.success(), "desktop resource build (openfile CLI) failed");
    tauri_build::build()
}
