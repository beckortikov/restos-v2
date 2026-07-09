// Package apkmeta извлекает versionCode/versionName из APK официанта, читая
// бинарный AndroidManifest.xml (AXML) без внешних зависимостей.
//
// Нужно для LAN-автообновления: касса раздаёт APK, приложение официанта
// сравнивает свой BuildConfig.VERSION_CODE с version_code раздаваемого файла.
// Раньше версия при загрузке не передавалась вовсе — теперь берём её из самого
// APK, без ручного ввода.
package apkmeta

import (
	"archive/zip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"unicode/utf16"
)

// Meta — извлечённые из APK версии.
type Meta struct {
	VersionCode int
	VersionName string
}

// Форматные константы AXML (см. AOSP ResourceTypes.h).
const (
	chunkStringPool   = 0x0001
	chunkStartElement = 0x0102
	flagUTF8          = 1 << 8 // ResStringPool_header.flags: UTF8_FLAG
	typeString        = 0x03   // Res_value.dataType: TYPE_STRING
	noEntry           = 0xFFFFFFFF
)

// Read открывает APK (zip) и парсит AndroidManifest.xml.
func Read(apkPath string) (Meta, error) {
	zr, err := zip.OpenReader(apkPath)
	if err != nil {
		return Meta{}, err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name == "AndroidManifest.xml" {
			rc, err := f.Open()
			if err != nil {
				return Meta{}, err
			}
			data, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return Meta{}, err
			}
			return ParseManifest(data)
		}
	}
	return Meta{}, errors.New("AndroidManifest.xml не найден в APK")
}

// ParseManifest разбирает бинарный AndroidManifest.xml и возвращает версии
// элемента <manifest>. Любой выход за границы буфера → ошибка (recover).
func ParseManifest(data []byte) (m Meta, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("повреждённый AndroidManifest.xml: %v", r)
		}
	}()
	if len(data) < 8 {
		return Meta{}, errors.New("AndroidManifest.xml слишком мал")
	}

	var strings []string
	// Верхнеуровневые чанки идут после 8-байтного заголовка XML-файла.
	pos := 8
	for pos+8 <= len(data) {
		ctype := int(binary.LittleEndian.Uint16(data[pos:]))
		size := int(binary.LittleEndian.Uint32(data[pos+4:]))
		if size < 8 || pos+size > len(data) {
			break
		}
		chunk := data[pos : pos+size]
		switch ctype {
		case chunkStringPool:
			strings = parseStringPool(chunk)
		case chunkStartElement:
			if name := elementName(chunk, strings); name == "manifest" {
				return parseManifestAttrs(chunk, strings), nil
			}
		}
		pos += size
	}
	return Meta{}, errors.New("<manifest> не найден в AndroidManifest.xml")
}

func parseStringPool(chunk []byte) []string {
	headerSize := int(binary.LittleEndian.Uint16(chunk[2:]))
	count := int(binary.LittleEndian.Uint32(chunk[8:]))
	flags := binary.LittleEndian.Uint32(chunk[16:])
	stringsStart := int(binary.LittleEndian.Uint32(chunk[20:]))
	isUTF8 := flags&flagUTF8 != 0

	out := make([]string, count)
	for i := 0; i < count; i++ {
		off := int(binary.LittleEndian.Uint32(chunk[headerSize+i*4:]))
		at := stringsStart + off
		if isUTF8 {
			out[i] = decodeUTF8(chunk, at)
		} else {
			out[i] = decodeUTF16(chunk, at)
		}
	}
	return out
}

func decodeUTF16(data []byte, pos int) string {
	n := int(binary.LittleEndian.Uint16(data[pos:]))
	pos += 2
	if n&0x8000 != 0 { // длина >0x7FFF — расширяется на второе слово
		n = ((n & 0x7FFF) << 16) | int(binary.LittleEndian.Uint16(data[pos:]))
		pos += 2
	}
	units := make([]uint16, n)
	for k := 0; k < n; k++ {
		units[k] = binary.LittleEndian.Uint16(data[pos:])
		pos += 2
	}
	return string(utf16.Decode(units))
}

func decodeUTF8(data []byte, pos int) string {
	// Сначала длина в символах (пропускаем), затем длина в байтах.
	if data[pos]&0x80 != 0 {
		pos += 2
	} else {
		pos++
	}
	n := int(data[pos])
	pos++
	if n&0x80 != 0 {
		n = ((n & 0x7F) << 8) | int(data[pos])
		pos++
	}
	return string(data[pos : pos+n])
}

// elementName — имя START_ELEMENT (ResXMLTree_attrExt.name по смещению 20).
func elementName(chunk []byte, strings []string) string {
	if len(chunk) < 24 {
		return ""
	}
	nameRef := int(binary.LittleEndian.Uint32(chunk[20:]))
	if nameRef < 0 || nameRef >= len(strings) {
		return ""
	}
	return strings[nameRef]
}

func parseManifestAttrs(chunk []byte, strings []string) Meta {
	var m Meta
	attrStart := int(binary.LittleEndian.Uint16(chunk[24:]))
	attrSize := int(binary.LittleEndian.Uint16(chunk[26:]))
	attrCount := int(binary.LittleEndian.Uint16(chunk[28:]))
	base := 16 + attrStart // ResXMLTree_attrExt начинается по смещению 16
	str := func(ref uint32) string {
		if ref == noEntry || int(ref) >= len(strings) {
			return ""
		}
		return strings[ref]
	}
	for i := 0; i < attrCount; i++ {
		a := base + i*attrSize
		if a+20 > len(chunk) {
			break
		}
		name := str(binary.LittleEndian.Uint32(chunk[a+4:]))
		rawValue := binary.LittleEndian.Uint32(chunk[a+8:])
		// Res_value: size(2) res0(1) dataType(1) data(4) начиная с a+12.
		dataType := chunk[a+15]
		data := binary.LittleEndian.Uint32(chunk[a+16:])
		switch name {
		case "versionCode":
			m.VersionCode = int(data)
		case "versionName":
			if rawValue != noEntry {
				m.VersionName = str(rawValue)
			} else if dataType == typeString {
				m.VersionName = str(data)
			}
		}
	}
	return m
}
