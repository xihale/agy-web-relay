package main

import (
	"bufio"
	"bytes"
	"compress/flate"
	"context"
	"crypto/tls"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

const (
	flagBinary        byte   = 0x01
	flagDeflate       byte   = 0x02
	deflateMinBytes          = 128
	maxWSMessageBytes uint32 = 64 * 1024 * 1024
)

func checkSameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func verifyBackendAuth(ctx context.Context, client *http.Client, backendOrigin string, r *http.Request) int {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, backendOrigin+"/relay-health", nil)
	if err != nil {
		return http.StatusInternalServerError
	}
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if cookie := r.Header.Get("Cookie"); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := client.Do(req)
	if err != nil {
		return http.StatusBadGateway
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return resp.StatusCode
	}
	return http.StatusOK
}

func bridgeWebTransportToWS(sess *webtransport.Session, backendWSURL string, r *http.Request) {
	defer sess.CloseWithError(0, "")

	acceptCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	stream, err := sess.AcceptStream(acceptCtx)
	cancel()
	if err != nil {
		return
	}
	defer stream.Close()

	dialer := websocket.Dialer{
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true},
		HandshakeTimeout:  5 * time.Second,
		EnableCompression: false,
	}
	upHeaders := http.Header{}
	upHeaders.Set("Origin", "https://"+r.Host)
	if auth := r.Header.Get("Authorization"); auth != "" {
		upHeaders.Set("Authorization", auth)
	}
	if cookie := r.Header.Get("Cookie"); cookie != "" {
		upHeaders.Set("Cookie", cookie)
	}
	upConn, _, err := dialer.DialContext(r.Context(), backendWSURL, upHeaders)
	if err != nil {
		return
	}
	defer upConn.Close()
	upConn.SetReadLimit(int64(maxWSMessageBytes))

	var closeOnce sync.Once
	teardown := func() {
		closeOnce.Do(func() {
			stream.CancelRead(0)
			stream.CancelWrite(0)
			stream.Close()
			upConn.Close()
			sess.CloseWithError(0, "")
		})
	}

	errCh := make(chan error, 2)

	// Upstream WS -> WebTransport stream
	go func() {
		bw := bufio.NewWriterSize(stream, 64*1024)
		var compBuf bytes.Buffer
		fw, _ := flate.NewWriter(&compBuf, 5)
		var hdr [5]byte
		for {
			msgType, data, err := upConn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			if msgType != websocket.TextMessage && msgType != websocket.BinaryMessage {
				continue
			}
			var flags byte
			if msgType == websocket.BinaryMessage {
				flags |= flagBinary
			}
			out := data
			if len(data) >= deflateMinBytes && fw != nil {
				compBuf.Reset()
				fw.Reset(&compBuf)
				if _, werr := fw.Write(data); werr == nil {
					if cerr := fw.Close(); cerr == nil && compBuf.Len() < len(data) {
						flags |= flagDeflate
						out = compBuf.Bytes()
					}
				}
			}
			hdr[0] = flags
			binary.BigEndian.PutUint32(hdr[1:5], uint32(len(out)))
			if _, werr := bw.Write(hdr[:]); werr != nil {
				errCh <- werr
				return
			}
			if len(out) > 0 {
				if _, werr := bw.Write(out); werr != nil {
					errCh <- werr
					return
				}
			}
			if ferr := bw.Flush(); ferr != nil {
				errCh <- ferr
				return
			}
		}
	}()

	// WebTransport stream -> Upstream WS
	go func() {
		var hdr [5]byte
		for {
			if _, err := io.ReadFull(stream, hdr[:]); err != nil {
				errCh <- err
				return
			}
			flags := hdr[0]
			length := binary.BigEndian.Uint32(hdr[1:5])
			if length > maxWSMessageBytes {
				errCh <- fmt.Errorf("frame too large: %d", length)
				return
			}
			payload := make([]byte, length)
			if length > 0 {
				if _, err := io.ReadFull(stream, payload); err != nil {
					errCh <- err
					return
				}
			}
			if flags&flagDeflate != 0 {
				fr := flate.NewReader(bytes.NewReader(payload))
				decomp, err := io.ReadAll(io.LimitReader(fr, int64(maxWSMessageBytes)+1))
				fr.Close()
				if err != nil || uint32(len(decomp)) > maxWSMessageBytes {
					errCh <- fmt.Errorf("deflate error")
					return
				}
				payload = decomp
			}
			msgType := websocket.TextMessage
			if flags&flagBinary != 0 {
				msgType = websocket.BinaryMessage
			}
			if err := upConn.WriteMessage(msgType, payload); err != nil {
				errCh <- err
				return
			}
		}
	}()

	<-errCh
	teardown()
}

func main() {
	listenAddr := flag.String("listen", "", "Listen address host:port")
	backendAddr := flag.String("backend", "", "Backend address host:port")
	certPath := flag.String("cert", "", "TLS certificate PEM path")
	keyPath := flag.String("key", "", "TLS private key PEM path")
	maxPacketSize := flag.Int("max-packet-size", 1200, "Initial QUIC packet size")
	flag.Parse()

	if *listenAddr == "" || *backendAddr == "" || *certPath == "" || *keyPath == "" {
		log.Fatal("Usage: agy-h3-edge --listen host:port --backend host:port --cert cert.pem --key key.pem")
	}

	cert, err := tls.LoadX509KeyPair(*certPath, *keyPath)
	if err != nil {
		log.Fatalf("load TLS cert/key: %v", err)
	}

	backendOrigin := "https://" + *backendAddr
	backendURL, err := url.Parse(backendOrigin)
	if err != nil {
		log.Fatalf("invalid backend address: %v", err)
	}
	backendWSURL := "wss://" + *backendAddr + "/connect-websocket"

	backendTransport := &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
		DisableCompression:  true,
		MaxIdleConns:        128,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   false,
	}
	authClient := &http.Client{
		Transport: backendTransport,
		Timeout:   3 * time.Second,
	}

	_, portStr, err := net.SplitHostPort(*listenAddr)
	if err != nil {
		log.Fatalf("invalid listen address %q: %v", *listenAddr, err)
	}
	listenPort, err := strconv.Atoi(portStr)
	if err != nil || listenPort <= 0 {
		log.Fatalf("invalid listen port %q", portStr)
	}
	altSvcHeader := fmt.Sprintf(`h3=":%d"; ma=2592000`, listenPort)

	var h3Server *http3.Server
	var wtServer *webtransport.Server

	proxy := &httputil.ReverseProxy{
		Transport:     backendTransport,
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(backendURL)
			pr.Out.Host = pr.In.Host
		},
		ModifyResponse: func(resp *http.Response) error {
			if resp.Request != nil && resp.Request.ProtoMajor < 3 {
				if h3Server == nil || h3Server.SetQUICHeaders(resp.Header) != nil || resp.Header.Get("Alt-Svc") == "" {
					resp.Header.Set("Alt-Svc", altSvcHeader)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "Upstream relay error: "+err.Error(), http.StatusBadGateway)
		},
	}

	pktSize := *maxPacketSize
	if pktSize < 1200 {
		pktSize = 1200
	}

	h3TLSConfig := http3.ConfigureTLSConfig(&tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
	})
	quicCfg := &quic.Config{
		InitialPacketSize:              uint16(pktSize),
		Allow0RTT:                      true,
		MaxIncomingStreams:             256,
		KeepAlivePeriod:                20 * time.Second,
		MaxIdleTimeout:                 60 * time.Second,
		InitialStreamReceiveWindow:     4 * 1024 * 1024,
		MaxStreamReceiveWindow:         16 * 1024 * 1024,
		InitialConnectionReceiveWindow: 8 * 1024 * 1024,
		MaxConnectionReceiveWindow:     32 * 1024 * 1024,
		EnableDatagrams:                true,
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/wt-websocket", func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor < 3 {
			w.Header().Set("Alt-Svc", altSvcHeader)
			http.Error(w, "WebTransport requires HTTP/3", http.StatusUpgradeRequired)
			return
		}
		if status := verifyBackendAuth(r.Context(), authClient, backendOrigin, r); status != http.StatusOK {
			http.Error(w, "Authentication required", status)
			return
		}
		sess, err := wtServer.Upgrade(w, r)
		if err != nil {
			return
		}
		bridgeWebTransportToWS(sess, backendWSURL, r)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	})

	h3Server = &http3.Server{
		Addr:            *listenAddr,
		Port:            listenPort,
		TLSConfig:       h3TLSConfig,
		QUICConfig:      quicCfg,
		Handler:         mux,
		EnableDatagrams: true,
	}
	webtransport.ConfigureHTTP3Server(h3Server)

	wtServer = &webtransport.Server{
		H3:          h3Server,
		CheckOrigin: checkSameOrigin,
	}

	tcpServer := &http.Server{
		Addr:    *listenAddr,
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
			NextProtos:   []string{"h2", "http/1.1"},
		},
	}

	errCh := make(chan error, 2)
	go func() {
		errCh <- tcpServer.ListenAndServeTLS(*certPath, *keyPath)
	}()
	go func() {
		errCh <- wtServer.ListenAndServeTLS(*certPath, *keyPath)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-sigCh:
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = tcpServer.Shutdown(ctx)
		_ = h3Server.Shutdown(ctx)
		_ = wtServer.Close()
		cancel()
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}
}
