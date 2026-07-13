const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors()); // Mengizinkan frontend web mengakses API ini
app.use(express.json()); // Mengizinkan server menerima data format JSON

// --- KONFIGURASI KONEKSI MYSQL ---
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',      
    password: '',      
    database: 'lean_pos'
});

// Cek Koneksi Database
db.connect((err) => {
    if (err) {
        console.error('Gagal terhubung ke database MySQL:', err.message);
        return;
    }
    console.log('Berhasil terhubung ke database MySQL (lean_pos)');
});

// --- API ENDPOINTS ---

// 1. Ambil Semua Data Produk (Untuk Katalog Kasir & Stok)
app.get('/api/produk', (req, res) => {
    const sql = "SELECT * FROM produk";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 2. Simpan Transaksi Baru (Proses Kasir)
app.post('/api/transaksi', (req, res) => {
    const { nomor_invoice, total_bayar, items } = req.body;

    // Gunakan transaksi SQL agar jika salah satu proses gagal, semua dibatalkan (ACID)
    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Insert ke tabel transaksi
        const sqlTx = "INSERT INTO transaksi (nomor_invoice, total_bayar) VALUES (?, ?)";
        db.query(sqlTx, [nomor_invoice, total_bayar], (err, result) => {
            if (err) {
                return db.rollback(() => res.status(500).json({ error: err.message }));
            }

            const transaksiId = result.insertId;
            
            // Siapkan query untuk detail transaksi dan update stok
            const sqlDetail = "INSERT INTO detail_transaksi (transaksi_id, produk_id, jumlah, subtotal) VALUES ?";
            const detailValues = items.map(item => [transaksiId, item.id, item.qty, (item.harga_jual * item.qty)]);

            // 1. Simpan ke Detail Transaksi
            db.query(sqlDetail, [detailValues], (err) => {
                if (err) {
                    return db.rollback(() => res.status(500).json({ error: err.message }));
                }

                // 2. Kurangi Stok Produk secara berkala (Looping Update)
                let queriesCompleted = 0;
                items.forEach(item => {
                    const sqlUpdateStok = "UPDATE produk SET stok = stok - ? WHERE id = ?";
                    db.query(sqlUpdateStok, [item.qty, item.id], (err) => {
                        if (err) {
                            return db.rollback(() => res.status(500).json({ error: err.message }));
                        }
                        
                        queriesCompleted++;
                        if (queriesCompleted === items.length) {
                            // Jika semua proses sukses, kunci perubahan di database
                            db.commit((err) => {
                                if (err) {
                                    return db.rollback(() => res.status(500).json({ error: err.message }));
                                }
                                res.json({ success: true, message: 'Transaksi berhasil disimpan!' });
                            });
                        }
                    });
                });
            });
        });
    });
});

// 3. Tambah Barang Baru ke MySQL
app.post('/api/produk', (req, res) => {
    const { kode_produk, nama_produk, harga_jual, stok } = req.body;
    const sql = "INSERT INTO produk (kode_produk, nama_produk, harga_jual, stok) VALUES (?, ?, ?, ?)";
    db.query(sql, [kode_produk, nama_produk, harga_jual, stok], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Barang berhasil ditambahkan!' });
    });
});

// 4. Update Data Barang di MySQL
app.put('/api/produk/:id', (req, res) => {
    const { id } = req.params;
    const { nama_produk, harga_jual, stok } = req.body;
    const sql = "UPDATE produk SET nama_produk = ?, harga_jual = ?, stok = ? WHERE id = ?";
    db.query(sql, [nama_produk, harga_jual, stok, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Barang berhasil diperbarui!' });
    });
});

// 5. Hapus Barang dari MySQL
app.delete('/api/produk/:id', (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM produk WHERE id = ?";
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Barang berhasil dihapus!' });
    });
});

// 6. Ambil Semua Data Riwayat Laporan Transaksi Real dari MySQL
app.get('/api/laporan', (req, res) => {
    const sql = "SELECT nomor_invoice, DATE_FORMAT(tanggal, '%d %b %Y %H:%i') AS tanggal_format, total_bayar FROM transaksi ORDER BY tanggal DESC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 7. API Analitik Dasbor: Mengambil Data untuk 3 Jenis Grafik Sekaligus
app.get('/api/analitik-grafik', (req, res) => {
    // Query A: Penjualan Harian (7 Hari Terakhir)
    const sqlHarian = `
        SELECT DATE_FORMAT(tanggal, '%d %b') AS hari, SUM(total_bayar) AS total 
        FROM transaksi 
        GROUP BY DATE(tanggal) 
        ORDER BY tanggal ASC LIMIT 7
    `;

    // Query B: Penjualan Bulanan (Tahun Berjalan)
    const sqlBulanan = `
        SELECT DATE_FORMAT(tanggal, '%M') AS bulan, SUM(total_bayar) AS total 
        FROM transaksi 
        GROUP BY MONTH(tanggal) 
        ORDER BY MONTH(tanggal) ASC
    `;

    // Query C: Produk Terlaris (Untuk Grafik Donat)
    const sqlDonut = `
        SELECT p.nama_produk, SUM(dt.jumlah) AS total_terjual 
        FROM detail_transaksi dt
        JOIN produk p ON dt.produk_id = p.id
        GROUP BY dt.produk_id 
        ORDER BY total_terjual DESC LIMIT 5
    `;

    // Jalankan query secara paralel di MySQL
    db.query(sqlHarian, (err, harianRes) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.query(sqlBulanan, (err, bulananRes) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.query(sqlDonut, (err, donutRes) => {
                if (err) return res.status(500).json({ error: err.message });
                
                // Kirimkan bungkusan data ke frontend
                res.json({
                    harian: harianRes,
                    bulanan: bulananRes,
                    donut: donutRes
                });
            });
        });
    });
});

// 8. Ambil Detail Barang Berdasarkan Nomor Invoice (Untuk Cetak Nota Satuan)
app.get('/api/laporan/:invoice', (req, res) => {
    const { invoice } = req.params;
    const sql = `
        SELECT p.nama_produk, dt.jumlah, p.harga_jual, dt.subtotal 
        FROM detail_transaksi dt
        JOIN transaksi t ON dt.transaksi_id = t.id
        JOIN produk p ON dt.produk_id = p.id
        WHERE t.nomor_invoice = ?
    `;
    db.query(sql, [invoice], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Jalankan Server di Port 3000
app.listen(3000, () => {
    console.log('Server berjalan di http://localhost:3000');
});