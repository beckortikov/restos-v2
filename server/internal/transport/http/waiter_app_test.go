//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

// Раздача APK официанта (вариант C): менеджер загружает APK через настройки →
// файл хранится в DataDir → телефон качает по публичному /download/waiter.apk.
func TestWaiterApp_UploadInfoDownload(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	apk := []byte("PK\x03\x04 fake-apk-payload-12345")

	type info struct {
		Available    bool   `json:"available"`
		Version      string `json:"version"`
		SizeBytes    int64  `json:"size_bytes"`
		DownloadPath string `json:"download_path"`
	}

	// 1) До загрузки — APK недоступен.
	r0, b0 := f.get(t, "/api/v1/waiter-app", tok)
	if r0.StatusCode != http.StatusOK {
		t.Fatalf("info: %d %s", r0.StatusCode, b0)
	}
	var i0 info
	_ = json.Unmarshal(b0, &i0)
	if i0.Available {
		t.Fatal("до загрузки APK должен быть недоступен")
	}

	// 2) Загружаем APK (multipart) с версией.
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	_ = mw.WriteField("version", "0.2.11")
	fw, _ := mw.CreateFormFile("file", "app-release.apk")
	_, _ = fw.Write(apk)
	_ = mw.Close()
	req, _ := http.NewRequest("POST", f.srv.URL+"/api/v1/waiter-app", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	ub, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d %s", resp.StatusCode, ub)
	}

	// 3) Info → доступен, версия и размер совпадают.
	r1, b1 := f.get(t, "/api/v1/waiter-app", tok)
	var i1 info
	if err := json.Unmarshal(b1, &i1); err != nil {
		t.Fatalf("info parse: %s (%s)", err, b1)
	}
	_ = r1
	if !i1.Available || i1.Version != "0.2.11" || i1.SizeBytes != int64(len(apk)) {
		t.Fatalf("после загрузки ожидали available+версия 0.2.11+размер %d, получили %+v", len(apk), i1)
	}
	if i1.DownloadPath != "/download/waiter.apk" {
		t.Fatalf("download_path = %q", i1.DownloadPath)
	}

	// 4) Публичное скачивание БЕЗ авторизации → байты совпадают, MIME — apk.
	dl, err := http.Get(f.srv.URL + "/download/waiter.apk")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(dl.Body)
	dl.Body.Close()
	if dl.StatusCode != http.StatusOK {
		t.Fatalf("download: %d", dl.StatusCode)
	}
	if ct := dl.Header.Get("Content-Type"); ct != "application/vnd.android.package-archive" {
		t.Fatalf("Content-Type = %q, ожидали apk", ct)
	}
	if !bytes.Equal(got, apk) {
		t.Fatalf("скачанные байты не совпали с загруженными")
	}
}
