//go:build !nogui

package gui

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/yetone/magpie/internal/appdir"
)

// 仅明确启用的软件渲染开关改变 Windows 启动参数，默认不影响硬件加速。
func TestWindowsSoftwareRendering(t *testing.T) {
	for _, value := range []string{"", "0", "1"} {
		t.Run("value="+value, func(t *testing.T) {
			t.Setenv("MAGPIE_DISABLE_GPU", value)
			got := windowsOptions().AdditionalBrowserArgs
			if slices.Contains(got, "--disable-gpu") != (value == "1") {
				t.Fatalf("MAGPIE_DISABLE_GPU=%q: browser args %v", value, got)
			}
		})
	}
}

// #508: a portable magpie on Windows still made %APPDATA%\magpie.exe,
// WebView2's profile at Wails' default. Portable, the app's options put it
// in data\webview2; installed, they leave the default (and what is there).
func TestWindowsOptionsWebViewData(t *testing.T) {
	t.Setenv("APPIMAGE", "")
	t.Cleanup(func() { appdir.UseExecutable("") })
	r, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	appdir.UseExecutable("")
	if o := windowsOptions(); o.WebviewUserDataPath != "" || !o.DisableQuitOnLastWindowClosed {
		t.Fatalf("installed: %+v, want WebView2's default folder and no quit on last close", o)
	}

	exe := filepath.Join(r, "Magpie", "magpie.exe")
	if err := os.MkdirAll(filepath.Join(r, "Magpie", "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	appdir.UseExecutable(exe)
	o := windowsOptions()
	if want := filepath.Join(r, "Magpie", "data", "webview2"); o.WebviewUserDataPath != want {
		t.Fatalf("portable: WebviewUserDataPath = %q, want %q", o.WebviewUserDataPath, want)
	}
	if !o.DisableQuitOnLastWindowClosed {
		t.Fatal("portable: quits on last window closed")
	}
}
