package connectivity

import (
	"errors"
	"fmt"
	"net"
)

// Reason — категория причины недоступности из интернета.
type Reason string

const (
	// ReasonCGNATDetected — UPnP вернул адрес из CGNAT-диапазона (100.64.0.0/10).
	// Типичная ситуация в РФ у провайдеров с CGNAT.
	ReasonCGNATDetected Reason = "cgnat-detected"
	// ReasonNoIPv6 — ни на одном up-интерфейсе нет глобального IPv6.
	ReasonNoIPv6 Reason = "no-ipv6"
	// ReasonNoUPnP — UPnP discovery не нашёл роутер или mapping не получился.
	ReasonNoUPnP Reason = "no-upnp"
	// ReasonUPnPGotPrivate — UPnP отдал приватный/CGNAT адрес как "external IP".
	ReasonUPnPGotPrivate Reason = "upnp-private-ip"
)

// Status — итоговое состояние видимости сервера из интернета.
type Status string

const (
	// StatusOK — есть public IPv4 (UPnP сработал и вернул настоящий публичный
	// адрес) ИЛИ есть глобальный IPv6.
	StatusOK Status = "ok"
	// StatusLANOnly — UPnP не сработал и нет публичного IPv6: достижимы только
	// гости в локальной сети.
	StatusLANOnly Status = "lan-only"
	// StatusBehindCGNAT — UPnP вернул приватный/CGNAT-адрес: реально из
	// интернета не достучаться даже несмотря на mapping.
	StatusBehindCGNAT Status = "behind-cgnat"
)

// Diagnosis — результат диагностики reachability сервера из интернета.
type Diagnosis struct {
	Status      Status   `json:"status"`
	PublicIPv4  string   `json:"publicIPv4"` // "" если не определён или приватный
	PublicIPv6  string   `json:"publicIPv6"` // "" если нет
	UPnPWorked  bool     `json:"upnpWorked"`
	BehindCGNAT bool     `json:"behindCGNAT"`
	Reasons     []Reason `json:"reasons"`
}

// IsPrivateOrCGNAT — true если IPv4 в RFC1918 (10/8, 172.16/12, 192.168/16)
// или CGNAT-диапазоне 100.64.0.0/10 (RFC6598).
//
// CGNAT detection критичен: даже если UPnP отдал "external IP", он может
// быть внутренним адресом провайдера за carrier-grade NAT (типичная
// ситуация в РФ), и реально из интернета такой адрес недостижим.
//
// Не-IPv4 входы (включая nil и IPv6) → false.
func IsPrivateOrCGNAT(ip net.IP) bool {
	if ip == nil {
		return false
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	if isPrivateIPv4(ip4) {
		return true
	}
	// 100.64.0.0/10 — диапазон 100.64.0.0 .. 100.127.255.255 (RFC6598).
	if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
		return true
	}
	return false
}

// PublicIPv6 возвращает первый глобальный (2000::/3) IPv6-адрес среди
// up-интерфейсов хоста. Возвращает "" если такого нет.
//
// Глобальный IPv6 = публичный по дизайну (без NAT), так что наличие такого
// адреса означает что сервер достижим из интернета по [v6]:port.
//
// Skip:
//   - loopback (::1)
//   - link-local (fe80::/10)
//   - ULA (fc00::/7)
//   - не входящий в 2000::/3
//   - адреса с FlagUp == 0
//
// Temporary/deprecated IPv6 не отделяются (Go stdlib не выставляет соответ-
// ствующий флаг кросс-платформенно): берём первый подходящий.
func PublicIPv6() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", fmt.Errorf("connectivity: net.Interfaces: %w", err)
	}

	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			// Один битый интерфейс не должен ломать enumeration.
			continue
		}

		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			default:
				continue
			}
			if ip == nil {
				continue
			}
			// Только IPv6: To4() != nil означает IPv4 (включая v4-mapped).
			if ip.To4() != nil {
				continue
			}
			if len(ip) != net.IPv6len {
				continue
			}
			if ip.IsLoopback() {
				continue
			}
			if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
				continue
			}
			if ip.IsMulticast() {
				continue
			}
			// ULA: fc00::/7 — старший октет 0xFC или 0xFD.
			if ip[0] == 0xfc || ip[0] == 0xfd {
				continue
			}
			// Глобальный unicast: 2000::/3 — старшие 3 бита == 001,
			// то есть 0x20..0x3F в первом байте.
			if ip[0]&0xe0 != 0x20 {
				continue
			}
			return ip.String(), nil
		}
	}

	return "", nil
}

// Diagnose принимает результат UPnP-маппинга и собирает Diagnosis.
//
// upnpExternalIP — то что вернул UPnP в Mapping.ExternalIP, или "" если
// UPnP не работала вовсе. CGNAT-detection происходит только если
// upnpExternalIP непустой.
//
// Логика:
//  1. Получаем глобальный IPv6 (если есть).
//  2. Если UPnP сработал, проверяем не приватный/CGNAT ли это.
//  3. Status: OK если есть публичный v4 или v6; BehindCGNAT если UPnP
//     отдал приватный; иначе LANOnly.
//  4. Reasons собираются для UI / логов.
func Diagnose(upnpExternalIP string) Diagnosis {
	ipv6, _ := PublicIPv6()

	publicV4 := ""
	cgnat := false
	upnpWorked := upnpExternalIP != ""

	if upnpWorked {
		parsed := net.ParseIP(upnpExternalIP)
		if parsed != nil && IsPrivateOrCGNAT(parsed) {
			cgnat = true
			// publicV4 не выставляем — адрес не публичный.
		} else if parsed != nil {
			publicV4 = upnpExternalIP
		}
		// parsed == nil (мусор от роутера) → ни publicV4, ни cgnat.
	}

	var status Status
	switch {
	case publicV4 != "" || ipv6 != "":
		status = StatusOK
	case cgnat:
		status = StatusBehindCGNAT
	default:
		status = StatusLANOnly
	}

	var reasons []Reason
	if cgnat {
		reasons = append(reasons, ReasonCGNATDetected)
	}
	if !upnpWorked {
		reasons = append(reasons, ReasonNoUPnP)
	}
	if upnpWorked && cgnat {
		reasons = append(reasons, ReasonUPnPGotPrivate)
	}
	if ipv6 == "" {
		reasons = append(reasons, ReasonNoIPv6)
	}

	return Diagnosis{
		Status:      status,
		PublicIPv4:  publicV4,
		PublicIPv6:  ipv6,
		UPnPWorked:  upnpWorked,
		BehindCGNAT: cgnat,
		Reasons:     reasons,
	}
}

// errPublicIPv6Unavailable — sentinel для будущей внешней проверки доступности
// IPv6 (например, через активный probe). Сейчас не используется: PublicIPv6
// возвращает ("", nil) если адреса нет, а ошибку — только при сбое
// net.Interfaces.
var errPublicIPv6Unavailable = errors.New("connectivity: no global IPv6 address found")

// _ удерживает ссылку на errPublicIPv6Unavailable чтобы линтеры не вырезали
// его как unused. Sentinel оставлен для расширения API.
var _ = errPublicIPv6Unavailable
