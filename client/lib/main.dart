import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// TODO: put your deployed server URL here (no trailing slash)
const kServerUrl = 'https://cloudstation-server.onrender.com';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(useMaterial3: true),
        home: const Gate(),
      );
}

// ---------- API ----------
Future<String> deviceId() async {
  final info = DeviceInfoPlugin();
  if (Platform.isIOS) return (await info.iosInfo).identifierForVendor ?? 'ios-unknown';
  return (await info.androidInfo).id;
}

Future<http.Response> api(String path, {Map? body, String? token}) {
  return http.post(
    Uri.parse('$kServerUrl$path'),
    headers: {
      'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    },
    body: jsonEncode(body ?? {}),
  );
}

// ---------- Gate: saved token? ----------
class Gate extends StatefulWidget {
  const Gate({super.key});
  @override
  State<Gate> createState() => _GateState();
}

class _GateState extends State<Gate> {
  Widget? page;
  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final p = await SharedPreferences.getInstance();
    final token = p.getString('token');
    if (token == null) return _set(const CodeScreen());
    try {
      final r = await http.get(Uri.parse('$kServerUrl/api/me'),
          headers: {'Authorization': 'Bearer $token'});
      if (r.statusCode == 200) return _set(SessionScreen(token: token));
      await p.remove('token');
    } catch (_) {
      return _set(SessionScreen(token: token)); // offline: try anyway
    }
    _set(const CodeScreen());
  }

  void _set(Widget w) => setState(() => page = w);

  @override
  Widget build(BuildContext context) =>
      page ?? const Scaffold(body: Center(child: CircularProgressIndicator()));
}

// ---------- Code screen ----------
class CodeScreen extends StatefulWidget {
  const CodeScreen({super.key});
  @override
  State<CodeScreen> createState() => _CodeScreenState();
}

class _CodeScreenState extends State<CodeScreen> {
  final ctrl = TextEditingController();
  String? error;
  bool busy = false;

  Future<void> _submit() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final r = await api('/api/redeem',
          body: {'code': ctrl.text.trim(), 'deviceId': await deviceId()});
      final data = jsonDecode(r.body);
      if (r.statusCode == 200) {
        final p = await SharedPreferences.getInstance();
        await p.setString('token', data['token']);
        if (!mounted) return;
        Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => SessionScreen(token: data['token'])));
        return;
      }
      setState(() => error = data['error'] ?? 'Error');
    } catch (_) {
      setState(() => error = 'No connection');
    }
    setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('CloudStation-4',
                  style: TextStyle(fontSize: 30, fontWeight: FontWeight.bold)),
              const SizedBox(height: 28),
              TextField(
                controller: ctrl,
                textAlign: TextAlign.center,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                    labelText: 'Access Code', border: OutlineInputBorder()),
              ),
              if (error != null)
                Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(error!, style: const TextStyle(color: Colors.redAccent))),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: FilledButton(
                    onPressed: busy ? null : _submit,
                    child: busy
                        ? const CircularProgressIndicator()
                        : const Text('Enter')),
              ),
            ]),
          ),
        ),
      );
}

// ---------- Session screen (stream view goes here later) ----------
class SessionScreen extends StatefulWidget {
  final String token;
  const SessionScreen({super.key, required this.token});
  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  int? sessionId;
  bool muted = false;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    final r = await api('/api/session/start', token: widget.token);
    if (r.statusCode != 200) return _logout();
    sessionId = jsonDecode(r.body)['sessionId'];
    timer = Timer.periodic(const Duration(seconds: 20), (_) => _ping());
    setState(() {});
  }

  Future<void> _ping() async {
    final r = await api('/api/session/ping',
        body: {'sessionId': sessionId}, token: widget.token);
    if (r.statusCode == 403 || r.statusCode == 401) return _logout(); // banned/deleted
    if (r.statusCode == 200 && mounted) {
      setState(() => muted = jsonDecode(r.body)['muted'] == true);
    }
  }

  Future<void> _logout() async {
    timer?.cancel();
    final p = await SharedPreferences.getInstance();
    await p.remove('token');
    if (!mounted) return;
    Navigator.of(context)
        .pushReplacement(MaterialPageRoute(builder: (_) => const CodeScreen()));
  }

  @override
  void dispose() {
    timer?.cancel();
    if (sessionId != null) {
      api('/api/session/end', body: {'sessionId': sessionId}, token: widget.token);
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('PS4'), actions: [
          if (muted) const Icon(Icons.mic_off, color: Colors.redAccent),
          IconButton(icon: const Icon(Icons.logout), onPressed: _logout),
        ]),
        body: const Center(
          // TODO: PS4 Remote Play stream view (Chiaki-based) will be placed here
          child: Text('PS4 stream will appear here',
              style: TextStyle(fontSize: 18)),
        ),
      );
}