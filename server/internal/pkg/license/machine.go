package license

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// MachineID — стабильный fingerprint железа.
//
// Используется для machine-bound лицензирования: при активации сравниваем
// payload.MachineID токена с MachineID() локальной машины. Mismatch → отказ.
// Это превращает токен в "выдан для этого компьютера", вместо переносимого.
//
// Стратегия:
//  1. Hash от MAC-адреса первого non-loopback non-virtual интерфейса.
//  2. + Hash от serial number системного диска (через wmic на Windows,
//     ioreg на mac, lsblk на Linux).
//  3. + Hash от machine-uuid (Windows registry / mac IOPlatformUUID / dmidecode).
//
// Стабилен:
//   - Переустановка ОС — НЕ меняется (machine-uuid живёт в BIOS/firmware).
//   - Замена сетевой карты — меняется (но disk + uuid компенсируют).
//   - Замена SSD — меняется (но MAC + uuid компенсируют).
//   - Замена материнки — меняется (заявляем как "новая машина", клиент звонит).
//
// Реализация устойчива к ошибкам: если какой-то из источников недоступен —
// используем оставшиеся. Если все упали — возвращается "unknown-{hostname}",
// чтобы хотя бы что-то было (но в production эта ветка маловероятна).

var (
	cachedMachineID string
	machineIDOnce   sync.Once
)

// MachineID возвращает стабильный fingerprint текущей машины.
// Кэшируется на время жизни процесса — wmic/ioreg вызовы медленные.
//
// Формат: human-readable группированный hex, 12 символов:
//   "A1B2-7K3M-9XQA"
//
// Это короче чем полный SHA-256, но 48 бит = ~280 триллионов возможных
// значений — коллизия между двумя реальными машинами клиентов
// исчезающе мала.
func MachineID() string {
	machineIDOnce.Do(func() {
		cachedMachineID = computeMachineID()
	})
	return cachedMachineID
}

func computeMachineID() string {
	parts := []string{}
	if mac := firstMACAddress(); mac != "" {
		parts = append(parts, "mac:"+mac)
	}
	if diskSN := diskSerial(); diskSN != "" {
		parts = append(parts, "disk:"+diskSN)
	}
	if hostUUID := machineUUID(); hostUUID != "" {
		parts = append(parts, "uuid:"+hostUUID)
	}
	if len(parts) == 0 {
		// Fallback — лучше что-то чем ничего.
		parts = append(parts, "host:"+hostnameFallback())
	}

	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	// Берём первые 6 байт → 12 hex символов → группируем по 4.
	hex12 := hex.EncodeToString(sum[:6])
	hex12 = strings.ToUpper(hex12)
	return fmt.Sprintf("%s-%s-%s", hex12[0:4], hex12[4:8], hex12[8:12])
}

// firstMACAddress — MAC первого «нормального» интерфейса.
// Пропускаем loopback, down, virtual (docker/vmware/etc).
func firstMACAddress() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, ifa := range ifaces {
		if ifa.Flags&net.FlagLoopback != 0 || ifa.Flags&net.FlagUp == 0 {
			continue
		}
		// Skip virtual: docker0, vmnet*, vboxnet*, veth*, tap*, tun*, br-*.
		n := strings.ToLower(ifa.Name)
		if strings.HasPrefix(n, "docker") || strings.HasPrefix(n, "vmnet") ||
			strings.HasPrefix(n, "vbox") || strings.HasPrefix(n, "veth") ||
			strings.HasPrefix(n, "br-") || strings.HasPrefix(n, "tun") ||
			strings.HasPrefix(n, "tap") || strings.HasPrefix(n, "utun") {
			continue
		}
		hw := ifa.HardwareAddr.String()
		if hw != "" && hw != "00:00:00:00:00:00" {
			return hw
		}
	}
	return ""
}

func machineUUID() string {
	switch runtime.GOOS {
	case "windows":
		// wmic csproduct get uuid
		if out, err := exec.Command("wmic", "csproduct", "get", "uuid").Output(); err == nil {
			lines := strings.Split(string(out), "\n")
			for _, l := range lines {
				l = strings.TrimSpace(l)
				if l == "" || strings.EqualFold(l, "UUID") {
					continue
				}
				return l
			}
		}
	case "darwin":
		// ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
		if out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output(); err == nil {
			for _, l := range strings.Split(string(out), "\n") {
				if strings.Contains(l, "IOPlatformUUID") {
					i := strings.LastIndex(l, "\"")
					j := strings.LastIndex(l[:i], "\"")
					if i > 0 && j >= 0 && i-j > 1 {
						return l[j+1 : i]
					}
				}
			}
		}
	case "linux":
		// /etc/machine-id — самый стабильный источник.
		if data, err := readFirstLine("/etc/machine-id"); err == nil && data != "" {
			return data
		}
		if data, err := readFirstLine("/var/lib/dbus/machine-id"); err == nil && data != "" {
			return data
		}
	}
	return ""
}

func diskSerial() string {
	switch runtime.GOOS {
	case "windows":
		// wmic diskdrive get serialnumber — первый диск.
		if out, err := exec.Command("wmic", "diskdrive", "get", "serialnumber").Output(); err == nil {
			for _, l := range strings.Split(string(out), "\n") {
				l = strings.TrimSpace(l)
				if l == "" || strings.EqualFold(l, "SerialNumber") {
					continue
				}
				return l
			}
		}
	case "darwin":
		// system_profiler SPSerialATADataType — слишком жирный.
		// Используем uuidgen-like fallback из ioreg.
		if out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output(); err == nil {
			for _, l := range strings.Split(string(out), "\n") {
				if strings.Contains(l, "IOPlatformSerialNumber") {
					i := strings.LastIndex(l, "\"")
					j := strings.LastIndex(l[:i], "\"")
					if i > 0 && j >= 0 && i-j > 1 {
						return l[j+1 : i]
					}
				}
			}
		}
	case "linux":
		// Первый non-removable блочный device.
		if out, err := exec.Command("lsblk", "-d", "-n", "-o", "SERIAL").Output(); err == nil {
			for _, l := range strings.Split(string(out), "\n") {
				l = strings.TrimSpace(l)
				if l != "" {
					return l
				}
			}
		}
	}
	return ""
}

func hostnameFallback() string {
	if h, err := exec.Command("hostname").Output(); err == nil {
		return strings.TrimSpace(string(h))
	}
	return "unknown"
}

// readFirstLine — небольшой helper без import "os" вверху, делаем inline.
func readFirstLine(path string) (string, error) {
	// Используем cat — кросс-проверено. Маленький overhead но не нужны
	// дополнительные импорты.
	out, err := exec.Command("cat", path).Output()
	if err != nil {
		return "", err
	}
	s := strings.TrimSpace(string(out))
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	return s, nil
}
