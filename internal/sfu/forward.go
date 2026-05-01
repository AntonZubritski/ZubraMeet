package sfu

import (
	"errors"
	"io"

	"github.com/pion/webrtc/v4"
)

// forwardRTP копирует RTP-пакеты remote→local. Завершается когда remote
// закрывается (ErrClosedPipe / io.EOF) или local закрыт.
//
// done закрывается при выходе — для будущей синхронизации/тестов.
func forwardRTP(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP, done chan struct{}) {
	defer func() {
		select {
		case <-done:
		default:
			close(done)
		}
	}()

	rtpBuf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(rtpBuf)
		if err != nil {
			return
		}
		if _, err := local.Write(rtpBuf[:n]); err != nil {
			if errors.Is(err, io.ErrClosedPipe) {
				continue
			}
			return
		}
	}
}

// drainRTCP читает RTCP-пакеты с RTPSender и выбрасывает их. Pion требует
// обязательно дренировать sender, иначе SRTCP-сессия зависнет на буферах.
// Завершается когда sender закрывается.
func drainRTCP(sender *webrtc.RTPSender) {
	rtcpBuf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(rtcpBuf); err != nil {
			return
		}
	}
}
