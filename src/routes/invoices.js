router.get('/stats', require('../middleware/auth'), async (req, res) => {
  try {
    const clientId = req.client.id;
    const [
      playlists, playlistItems, media, screens, plan
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM playlists WHERE client_id = $1', [clientId]),
      pool.query(`
        SELECT p.name as playlist_name, COUNT(pi.id) as item_count
        FROM playlists p
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        WHERE p.client_id = $1
        GROUP BY p.id, p.name
        ORDER BY item_count DESC
      `, [clientId]),
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE type = 'video') as videos,
          COUNT(*) FILTER (WHERE type = 'image') as images,
          COALESCE(SUM(size), 0) as total_size
        FROM media WHERE client_id = $1
      `, [clientId]),
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'online') as online,
          COUNT(*) FILTER (WHERE rotation = 90 OR rotation = 270) as vertical,
          COUNT(*) FILTER (WHERE rotation = 0 OR rotation = 180) as horizontal,
          app_version
        FROM screens WHERE client_id = $1
        GROUP BY app_version
      `, [clientId]),
      pool.query(`
        SELECT p.name, p.max_screens, p.max_companies, p.price
        FROM clients c
        LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = $1
      `, [clientId])
    ]);

    const mediaData = media.rows[0];
    const screenRows = screens.rows;
    const totalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.total), 0);
    const onlineScreens = screenRows.reduce((acc, r) => acc + parseInt(r.online), 0);
    const verticalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.vertical), 0);
    const horizontalScreens = screenRows.reduce((acc, r) => acc + parseInt(r.horizontal), 0);

    const versionMap = {};
    screenRows.forEach(r => {
      if (r.app_version) {
        versionMap[r.app_version] = (versionMap[r.app_version] || 0) + parseInt(r.total);
      }
    });

    const playlistItemsSorted = playlistItems.rows;
    const mostItems = playlistItemsSorted[0] || null;
    const leastItems = playlistItemsSorted[playlistItemsSorted.length - 1] || null;

    res.json({
      plan: plan.rows[0] || null,
      playlists: parseInt(playlists.rows[0].count),
      most_items_playlist: mostItems,
      least_items_playlist: leastItems,
      media: {
        total: parseInt(mediaData.total),
        videos: parseInt(mediaData.videos),
        images: parseInt(mediaData.images),
        total_size: parseInt(mediaData.total_size)
      },
      screens: {
        total: totalScreens,
        online: onlineScreens,
        vertical: verticalScreens,
        horizontal: horizontalScreens,
        versions: versionMap
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});