package apkmeta

import (
	"os"
	"path/filepath"
	"testing"
)

// Голден: реальный AndroidManifest.xml из debug-сборки waiter-приложения
// (versionCode 18, versionName "0.2.16"). Извлечён:
//   unzip -p app-debug.apk AndroidManifest.xml > testdata/AndroidManifest.xml
func TestParseManifest_Golden(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "AndroidManifest.xml"))
	if err != nil {
		t.Fatalf("не удалось прочитать фикстуру: %v", err)
	}
	m, err := ParseManifest(data)
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if m.VersionCode != 18 {
		t.Errorf("VersionCode = %d, ожидалось 18", m.VersionCode)
	}
	if m.VersionName != "0.2.16" {
		t.Errorf("VersionName = %q, ожидалось \"0.2.16\"", m.VersionName)
	}
}

func TestParseManifest_Garbage(t *testing.T) {
	// Мусор не должен паниковать — только ошибка.
	if _, err := ParseManifest([]byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09}); err == nil {
		t.Error("ожидалась ошибка на мусорных данных")
	}
	if _, err := ParseManifest(nil); err == nil {
		t.Error("ожидалась ошибка на nil")
	}
}
