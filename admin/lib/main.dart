import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

void main() => runApp(const AdminApp());

class AdminApp extends StatelessWidget {
  const AdminApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(useMaterial3: true),
        home: const Gate(),
      );
}

// ---------- API ----------
class Api {
  final String url, key;
  Api(this.url, this.key);
  Map<String, String> get _h =>
      {'x-admin-key': key, 'Content-Type': 'application/json'};

  Future<dynamic> get(String p) async {
    final r = await http.get(Uri.parse('$url$p'), headers: _h);
    if (r.statusCode != 200) throw Exception('HTTP ${r.statusCode}');
    return jsonDecode(r.body);
  }

  Future<dynamic> post(String p, [Map? body]) async {
    final r = await http.post(Uri.parse('$url$p'),
        headers: _h, body: jsonEncode(body ?? {}));
    if (r.statusCode != 200) throw Exception('HTTP ${r.statusCode}');
    return jsonDecode(r.body);
  }

  Future<void> del(String p) async {
    final r = await http.delete(Uri.parse('$url$p'), headers: _h);
    if (r.statusCode != 200) throw Exception('HTTP ${r.statusCode}');
  }
}

// ---------- Gate ----------
class Gate extends StatefulWidget {
  const Gate({super.key});
  @override
  State<Gate> createState() => _GateState();
}

class _GateState extends State<Gate> {
  Api? api;
  bool loaded = false;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      final u = p.getString('url'), k = p.getString('key');
      setState(() {
        if (u != null && k != null) api = Api(u, k);
        loaded = true;
      });
    });
  }

  Future<void> _logout() async {
    final p = await SharedPreferences.getInstance();
    await p.clear();
    setState(() => api = null);
  }

  @override
  Widget build(BuildContext context) {
    if (!loaded) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (api == null) return LoginScreen(onDone: (a) => setState(() => api = a));
    return Home(api: api!, onLogout: _logout);
  }
}

// ---------- Login ----------
class LoginScreen extends StatefulWidget {
  final void Function(Api) onDone;
  const LoginScreen({super.key, required this.onDone});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final url = TextEditingController(), key = TextEditingController();
  String? error;
  bool busy = false;

  Future<void> _login() async {
    setState(() {
      busy = true;
      error = null;
    });
    final u = url.text.trim().replaceAll(RegExp(r'/+$'), '');
    final api = Api(u, key.text.trim());
    try {
      await api.get('/admin/codes');
      final p = await SharedPreferences.getInstance();
      await p.setString('url', u);
      await p.setString('key', key.text.trim());
      widget.onDone(api);
    } catch (e) {
      setState(() => error = 'Failed: $e');
    }
    setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('CloudStation-4 Admin',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold)),
              const SizedBox(height: 24),
              TextField(
                  controller: url,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                      labelText: 'Server URL', border: OutlineInputBorder())),
              const SizedBox(height: 14),
              TextField(
                  controller: key,
                  obscureText: true,
                  decoration: const InputDecoration(
                      labelText: 'Admin Key', border: OutlineInputBorder())),
              if (error != null)
                Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(error!, style: const TextStyle(color: Colors.redAccent))),
              const SizedBox(height: 20),
              SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: FilledButton(
                      onPressed: busy ? null : _login, child: const Text('Login'))),
            ]),
          ),
        ),
      );
}

// ---------- Home ----------
class Home extends StatefulWidget {
  final Api api;
  final VoidCallback onLogout;
  const Home({super.key, required this.api, required this.onLogout});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  int tab = 0;
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: Text(tab == 0 ? 'Users' : 'Codes'),
          actions: [IconButton(icon: const Icon(Icons.logout), onPressed: widget.onLogout)],
        ),
        body: tab == 0 ? UsersTab(api: widget.api) : CodesTab(api: widget.api),
        bottomNavigationBar: NavigationBar(
          selectedIndex: tab,
          onDestinationSelected: (i) => setState(() => tab = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.people), label: 'Users'),
            NavigationDestination(icon: Icon(Icons.vpn_key), label: 'Codes'),
          ],
        ),
      );
}

// ---------- Users ----------
class UsersTab extends StatefulWidget {
  final Api api;
  const UsersTab({super.key, required this.api});
  @override
  State<UsersTab> createState() => _UsersTabState();
}

class _UsersTabState extends State<UsersTab> {
  List users = [];
  String? error;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    _load();
    timer = Timer.periodic(const Duration(seconds: 15), (_) => _load());
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await widget.api.get('/admin/users');
      if (mounted) setState(() { users = d; error = null; });
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  Future<void> _act(Map u, String action) async {
    try {
      if (action == 'delete') {
        final ok = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: Text('Delete ${u['name']}?'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
              TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete')),
            ],
          ),
        );
        if (ok != true) return;
        await widget.api.del('/admin/users/${u['id']}');
      } else {
        await widget.api.post('/admin/users/${u['id']}/$action');
      }
      _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: users.isEmpty
            ? ListView(children: [
                Padding(
                    padding: const EdgeInsets.all(40),
                    child: Center(child: Text(error ?? 'No users yet')))
              ])
            : ListView.separated(
                itemCount: users.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final u = users[i];
                  final banned = u['status'] == 'banned';
                  final muted = u['muted'] == 1 || u['muted'] == true;
                  return ListTile(
                    leading: CircleAvatar(
                        radius: 7,
                        backgroundColor: banned
                            ? Colors.red
                            : (u['online'] == true ? Colors.green : Colors.grey)),
                    title: Row(children: [
                      Flexible(child: Text('${u['name']}', overflow: TextOverflow.ellipsis)),
                      if (banned) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.block, size: 16, color: Colors.red)),
                      if (muted) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.mic_off, size: 16, color: Colors.orange)),
                    ]),
                    subtitle: Text(
                        '${u['code']}  •  ${u['hours']} h  •  ${u['last_game'] ?? '-'}'),
                    trailing: PopupMenuButton<String>(
                      onSelected: (a) => _act(u, a),
                      itemBuilder: (_) => [
                        PopupMenuItem(value: banned ? 'unban' : 'ban', child: Text(banned ? 'Unban' : 'Ban')),
                        PopupMenuItem(value: muted ? 'unmute' : 'mute', child: Text(muted ? 'Unmute' : 'Mute')),
                        const PopupMenuItem(value: 'delete', child: Text('Delete')),
                      ],
                    ),
                  );
                },
              ),
      );
}

// ---------- Codes ----------
class CodesTab extends StatefulWidget {
  final Api api;
  const CodesTab({super.key, required this.api});
  @override
  State<CodesTab> createState() => _CodesTabState();
}

class _CodesTabState extends State<CodesTab> {
  List codes = [];
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await widget.api.get('/admin/codes');
      if (mounted) setState(() { codes = d; error = null; });
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    }
  }

  Future<void> _create() async {
    final ctrl = TextEditingController();
    final label = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('New code'),
        content: TextField(controller: ctrl, decoration: const InputDecoration(labelText: 'Name / note')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(c, ctrl.text), child: const Text('Create')),
        ],
      ),
    );
    if (label == null) return;
    try {
      final r = await widget.api.post('/admin/codes', {'label': label});
      await Clipboard.setData(ClipboardData(text: r['code']));
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Code ${r['code']} copied')));
      _load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _revoke(String code) async {
    await widget.api.post('/admin/codes/$code/revoke');
    _load();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: FloatingActionButton(onPressed: _create, child: const Icon(Icons.add)),
        body: RefreshIndicator(
          onRefresh: _load,
          child: codes.isEmpty
              ? ListView(children: [
                  Padding(padding: const EdgeInsets.all(40), child: Center(child: Text(error ?? 'No codes yet')))
                ])
              : ListView.separated(
                  itemCount: codes.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final c = codes[i];
                    final active = c['status'] == 'active';
                    return ListTile(
                      title: Text(c['code'],
                          style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 18,
                              decoration: active ? null : TextDecoration.lineThrough)),
                      subtitle: Text('${c['label'] ?? ''}  •  ${c['status']}'),
                      onTap: () {
                        Clipboard.setData(ClipboardData(text: c['code']));
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                      },
                      trailing: active
                          ? IconButton(icon: const Icon(Icons.cancel_outlined), onPressed: () => _revoke(c['code']))
                          : null,
                    );
                  },
                ),
        ),
      );
}
