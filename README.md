# Kerala Road Priority Dashboard

A static Leaflet map and traffic dashboard for the KLRAMS priority roads. Serve this folder over HTTP to preview it. GitHub Pages publishes the root of the main branch.

The overview uses simplified geometry. Selecting a road loads its full shapefile geometry, including sections without traffic surveys. Station coordinates are estimates interpolated along the matching section from the workbook's chainage. Dashboard AADT columns display the source survey-period ADT.

To regenerate the data, place Prioritised_Road_List_Lanes_Combined.xlsx, traffic adata new.xlsx, and shapefile folder beside this repository, install Python packages openpyxl, pyshp and shapely, then run python tools/build_data.py. The script checks road and station membership and reconciles source means before writing the browser data. The original inputs are stored outside this repository.
