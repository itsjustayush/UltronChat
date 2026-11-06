import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF050505),
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );
  runApp(const UltronChatMobileApp());
}

class UltronChatMobileApp extends StatelessWidget {
  const UltronChatMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'UltronChat',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF050505),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFFD6FF62),
          surface: Color(0xFF0D0D0D),
        ),
      ),
      home: const UltronChatWebViewScreen(),
    );
  }
}

class UltronChatWebViewScreen extends StatefulWidget {
  const UltronChatWebViewScreen({super.key});

  @override
  State<UltronChatWebViewScreen> createState() => _UltronChatWebViewScreenState();
}

class _UltronChatWebViewScreenState extends State<UltronChatWebViewScreen> {
  late final WebViewController _controller;
  bool _isLoading = true;
  String? _errorMessage;

  // Default web app endpoint (can be pointed to your Vercel deployment or local IP)
  static const String defaultAppUrl = 'https://ultronchat.vercel.app';
  static const String devFallbackUrl = 'http://10.0.2.2:3000'; // Android emulator localhost

  @override
  void initState() {
    super.initState();
    _requestInitialPermissions();
    _initWebViewController();
  }

  Future<void> _requestInitialPermissions() async {
    // Request camera permission for QR code scanning
    await Permission.camera.request();
  }

  void _initWebViewController() {
    late final PlatformWebViewControllerCreationParams params;
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
      );
    } else {
      params = const PlatformWebViewControllerCreationParams();
    }

    final WebViewController controller = WebViewController.fromPlatformCreationParams(
      params,
      onPermissionRequest: (request) {
        // Automatically grant WebRTC camera/microphone/display permissions inside WebView
        request.grant();
      },
    );

    controller
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF050505))
      ..setUserAgent('UltronChatMobile/1.0 (Android/iOS P2P Native Shell)')
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (String url) {
            setState(() {
              _isLoading = true;
              _errorMessage = null;
            });
          },
          onPageFinished: (String url) {
            setState(() {
              _isLoading = false;
            });
          },
          onWebResourceError: (WebResourceError error) {
            // If the remote production URL fails or user is testing offline, offer retry
            setState(() {
              _isLoading = false;
              _errorMessage = 'Could not connect to UltronChat (${error.description}).';
            });
          },
        ),
      );

    // Platform-specific configuration for WebRTC and file uploads
    if (controller.platform is AndroidWebViewController) {
      AndroidWebViewController.enableDebugging(true);
      (controller.platform as AndroidWebViewController)
          .setMediaPlaybackRequiresUserGesture(false);
    }

    // Load app URL
    final urlToLoad = Platform.isAndroid ? defaultAppUrl : defaultAppUrl;
    controller.loadRequest(Uri.parse(urlToLoad));
    _controller = controller;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;
        if (await _controller.canGoBack()) {
          await _controller.goBack();
        } else {
          SystemNavigator.pop();
        }
      },
      child: Scaffold(
        body: SafeArea(
          bottom: true,
          top: false,
          child: Stack(
            children: [
              WebViewWidget(controller: _controller),
              if (_isLoading)
                const Center(
                  child: CircularProgressIndicator(
                    color: Color(0xFFD6FF62),
                    strokeWidth: 2.5,
                  ),
                ),
              if (_errorMessage != null)
                Center(
                  child: Container(
                    margin: const EdgeInsets.all(24),
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      color: const Color(0xFF141414),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: Colors.white12),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.wifi_off, color: Color(0xFFD6FF62), size: 36),
                        const SizedBox(height: 12),
                        Text(
                          _errorMessage!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white70, fontSize: 13),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton.icon(
                          onPressed: () => _controller.reload(),
                          icon: const Icon(Icons.refresh, size: 16),
                          label: const Text('Retry Connection'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFD6FF62),
                            foregroundColor: Colors.black,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(999),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

